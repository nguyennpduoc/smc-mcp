// src/cysicClient.ts
// Typed wrapper around the Cysic AI Chat Completions endpoint (MiniMax M3).
//
// SHAPE — matches the project reference exactly:
//   axios.post(`${baseUrl}/chat/completions`, { model, messages }, { headers })
//   headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` }
//   default model: 'minimax-m3'
//   return: response.data.choices[0].message.content
//
// ADDED on top of the reference (still preserving shape & return value):
//   - per-request timeout (axios `timeout` option)
//   - retry + exponential backoff on HTTP 429 and 5xx
//   - clean error mapping to a small typed error class
//   - the API key is NEVER logged or included in error messages

import axios, { AxiosError, AxiosInstance } from 'axios';
import { getConfig, type AppConfig } from './config.js';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatCompletionRequest {
  messages: ChatMessage[];
  /** Override the configured model for this single call. */
  model?: string;
  /** Override the configured temperature (some Cysic models accept it). */
  temperature?: number;
}

/**
 * Clean error type exposed to the rest of the server. Carries a stable
 * `code` so callers (tools, server.ts) can decide how to surface failures
 * to the MCP client.
 */
export class CysicError extends Error {
  readonly code:
    | 'auth'           // 401 / 403
    | 'rate_limit'     // 429
    | 'server'         // 5xx
    | 'client'         // other 4xx
    | 'network'        // ECONN*, ETIMEDOUT, axios code !== 'ERR_BAD_RESPONSE'
    | 'bad_response'   // 200 but malformed body
    | 'config';        // missing/invalid env
  readonly status?: number;
  /** Sanitized upstream message (no key, no body dumps). */
  readonly upstream?: string;

  constructor(
    code: CysicError['code'],
    message: string,
    opts: { status?: number; upstream?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'CysicError';
    this.code = code;
    this.status = opts.status;
    this.upstream = opts.upstream;
    if (opts.cause !== undefined) {
      // Preserve the underlying error for debugging without leaking to MCP clients.
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

export interface CysicClientOptions {
  /** Inject for tests. Defaults to the shared axios instance. */
  http?: AxiosInstance;
  /** Inject for tests. Defaults to loadConfig(). */
  config?: AppConfig;
  /** Sleep fn for tests. Defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook called before each retry attempt. */
  onRetry?: (info: { attempt: number; delayMs: number; status?: number; error: unknown }) => void;
}

const DEFAULTS = {
  /** HTTP statuses that trigger a retry. */
  RETRY_STATUSES: new Set([408, 425, 429, 500, 502, 503, 504]),
  /** Max jitter as a fraction of the computed backoff. */
  JITTER: 0.2,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pick a "is this a network-level / timeout problem" verdict from an AxiosError
 * without ever touching the secret in the request config.
 */
function classifyAxiosError(err: AxiosError): {
  code: CysicError['code'];
  status?: number;
  upstream?: string;
} {
  const status = err.response?.status;
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return { code: 'auth', status, upstream: 'authentication failed' };
    }
    if (status === 429) {
      return { code: 'rate_limit', status, upstream: 'rate limited' };
    }
    if (status >= 500) {
      return { code: 'server', status, upstream: `upstream ${status}` };
    }
    if (status >= 400) {
      return { code: 'client', status, upstream: `upstream ${status}` };
    }
  }
  // No response — network/timeout/DNS.
  return { code: 'network', upstream: err.code ?? err.message ?? 'network error' };
}

/**
 * Build the request body exactly as the reference: { model, messages }.
 * Extra optional fields (temperature) are added only when supplied; this keeps
 * the call shape matching the reference for the common case.
 */
function buildRequestBody(messages: ChatMessage[], model: string, temperature?: number): Record<string, unknown> {
  const body: Record<string, unknown> = { model, messages };
  if (temperature !== undefined) body.temperature = temperature;
  return body;
}

/**
 * Extract the assistant text from a Cysic response. Throws CysicError('bad_response')
 * on missing/malformed payloads.
 */
function extractContent(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new CysicError('bad_response', 'Cysic returned a non-object response body');
  }
  const p = payload as { choices?: unknown };
  if (!Array.isArray(p.choices) || p.choices.length === 0) {
    throw new CysicError('bad_response', 'Cysic response missing "choices" array');
  }
  const first = p.choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content !== 'string') {
    throw new CysicError('bad_response', 'Cysic response missing choices[0].message.content string');
  }
  return content;
}

export class CysicClient {
  private readonly cfg: AppConfig;
  private readonly http: AxiosInstance;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry?: CysicClientOptions['onRetry'];

  constructor(opts: CysicClientOptions = {}) {
    this.cfg = opts.config ?? getConfig();
    this.http =
      opts.http ??
      axios.create({
        timeout: this.cfg.timeoutMs,
        // We never want axios to throw on any status — we'll inspect it ourselves.
        validateStatus: () => true,
      });
    this.sleep = opts.sleep ?? defaultSleep;
    this.onRetry = opts.onRetry;
  }

  /**
   * Run a chat completion against Cysic. Mirrors the project reference shape
   * but is retry-safe. Returns the assistant message content as a string.
   */
  async chat(req: ChatCompletionRequest): Promise<string> {
    const { messages, model = this.cfg.model, temperature } = req;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new CysicError('config', 'chat() requires at least one message');
    }

    const url = `${this.cfg.baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      // The API key flows through this header only — never logs.
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
    const data = buildRequestBody(messages, model, temperature);

    const maxAttempts = this.cfg.maxRetries + 1; // initial + retries
    let attempt = 0;
    let lastErr: unknown;

    while (attempt < maxAttempts) {
      attempt += 1;
      try {
        const response = await this.http.post(url, data, { headers });

        if (response.status >= 200 && response.status < 300) {
          return extractContent(response.data);
        }

        // Non-2xx. Decide whether to retry.
        const status = response.status;
        const upstream = sanitizeUpstream(response.data);

        if (DEFAULTS.RETRY_STATUSES.has(status) && attempt < maxAttempts) {
          const delayMs = this.backoffDelay(attempt);
          this.fireRetry({ attempt, delayMs, status, error: new CysicError(
            status === 429 ? 'rate_limit' : 'server',
            `Cysic ${status}; will retry`,
            { status, upstream },
          ) });
          await this.sleep(delayMs);
          lastErr = new CysicError(
            status === 429 ? 'rate_limit' : 'server',
            `Cysic ${status} after ${attempt} attempt(s)`,
            { status, upstream },
          );
          continue;
        }

        // 4xx (non-retry) or out of retries.
        const code: CysicError['code'] =
          status === 401 || status === 403 ? 'auth' :
          status === 429 ? 'rate_limit' :
          status >= 500 ? 'server' :
          'client';
        throw new CysicError(code, `Cysic request failed with status ${status}`, {
          status,
          upstream,
        });
      } catch (err) {
        if (err instanceof CysicError) {
          // Auth/config/bad_response errors are not retryable.
          if (err.code === 'auth' || err.code === 'config' || err.code === 'bad_response') {
            throw err;
          }
          // Already shaped — but still allow retry on rate_limit/server.
          if ((err.code === 'rate_limit' || err.code === 'server') && attempt < maxAttempts) {
            const delayMs = this.backoffDelay(attempt);
            this.fireRetry({ attempt, delayMs, status: err.status, error: err });
            await this.sleep(delayMs);
            lastErr = err;
            continue;
          }
          throw err;
        }

        // Axios error (network, timeout, etc.).
        if (axios.isAxiosError(err)) {
          const { code, status, upstream } = classifyAxiosError(err);
          if (code === 'network' && attempt < maxAttempts) {
            const delayMs = this.backoffDelay(attempt);
            this.fireRetry({ attempt, delayMs, status, error: err });
            await this.sleep(delayMs);
            lastErr = new CysicError(code, `network error (${upstream}); will retry`, { status, upstream, cause: err });
            continue;
          }
          throw new CysicError(code, `Cysic request failed: ${upstream}`, { status, upstream, cause: err });
        }

        // Unknown error type — wrap and surface.
        lastErr = new CysicError('client', err instanceof Error ? err.message : String(err), { cause: err });
        throw lastErr;
      }
    }

    // Should be unreachable; defensive.
    throw lastErr instanceof CysicError
      ? lastErr
      : new CysicError('client', 'Cysic request failed after retries');
  }

  /**
   * Convenience: high-level helper that takes raw prompt strings and constructs
   * a system+user pair, then returns the assistant text.
   */
  async complete(opts: { system?: string; prompt: string; temperature?: number; model?: string }): Promise<string> {
    const messages: ChatMessage[] = [];
    if (opts.system) messages.push({ role: 'system', content: opts.system });
    messages.push({ role: 'user', content: opts.prompt });
    return this.chat({ messages, temperature: opts.temperature, model: opts.model });
  }

  private backoffDelay(attempt: number): number {
    // Exponential: base * 2^(attempt-1), with ± jitter.
    const exp = this.cfg.backoffMs * 2 ** (attempt - 1);
    const jitter = exp * DEFAULTS.JITTER * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(exp + jitter));
  }

  private fireRetry(info: { attempt: number; delayMs: number; status?: number; error: unknown }): void {
    if (this.onRetry) {
      try {
        this.onRetry(info);
      } catch {
        // never let a buggy onRetry break the loop
      }
    }
  }
}

/**
 * Best-effort extraction of a short, safe string from an upstream error body.
 * Truncates to keep logs bounded. Does NOT include the API key, since the key
 * is in the request headers, not the response body.
 */
function sanitizeUpstream(body: unknown, maxLen = 240): string | undefined {
  if (body === undefined || body === null) return undefined;
  let s: string;
  try {
    if (typeof body === 'string') s = body;
    else s = JSON.stringify(body);
  } catch {
    s = String(body);
  }
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…`;
  return s;
}

// Singleton accessor for convenience in tools/server code.
let _default: CysicClient | undefined;
export function defaultCysicClient(): CysicClient {
  if (!_default) _default = new CysicClient();
  return _default;
}

/** Test helper to reset the singleton. */
export function _resetDefaultCysicClient(): void {
  _default = undefined;
}
