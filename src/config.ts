// src/config.ts
// Environment configuration loader. Loads .env via dotenv and validates that
// required secrets are present. Fails fast at startup if the API key is
// missing — we never want the server to start in a half-configured state.
//
// SECURITY: This module NEVER logs the API key. Errors redacted of key.

import 'dotenv/config';
import { z } from 'zod';

// Schema for env vars. Coerces numeric strings and applies sane defaults.
const EnvSchema = z.object({
  CYSIC_API_KEY: z
    .string({ required_error: 'CYSIC_API_KEY is required' })
    .min(8, 'CYSIC_API_KEY must be a non-empty string')
    // Refuse to run if the user left the placeholder in .env
    .refine((v) => v !== 'your-cysic-api-key-here', {
      message: 'CYSIC_API_KEY is set to the .env.example placeholder. Replace it with a real key.',
    }),
  CYSIC_BASE_URL: z
    .string()
    .url()
    .default('https://token-ai.cysic.xyz/v1'),
  CYSIC_MODEL: z.string().min(1).default('minimax-m3'),
  CYSIC_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  CYSIC_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
  CYSIC_BACKOFF_MS: z.coerce.number().int().positive().default(500),
});

export type AppConfig = {
  apiKey: string; // never logged
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  backoffMs: number;
};

let cached: AppConfig | undefined;

/**
 * Parse and validate process.env. Caches the result after first call so
 * unit tests can mutate env vars and call again to re-parse.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Surface a clean error; do NOT include env values in the message.
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg: AppConfig = {
    apiKey: parsed.data.CYSIC_API_KEY,
    baseUrl: parsed.data.CYSIC_BASE_URL,
    model: parsed.data.CYSIC_MODEL,
    timeoutMs: parsed.data.CYSIC_TIMEOUT_MS,
    maxRetries: parsed.data.CYSIC_MAX_RETRIES,
    backoffMs: parsed.data.CYSIC_BACKOFF_MS,
  };
  cached = cfg;
  return cfg;
}

/** Returns the cached config, loading it lazily on first call. */
export function getConfig(): AppConfig {
  return cached ?? loadConfig();
}

/** Test helper: forget the cached config. */
export function resetConfig(): void {
  cached = undefined;
}

/**
 * Returns a redacted view of the config safe to include in logs/errors.
 * The API key is replaced with a short fingerprint derived from the key,
 * not the key itself, so two log lines from the same process can be
 * correlated without ever exposing the secret.
 */
export function describeConfig(cfg: AppConfig = getConfig()): Record<string, unknown> {
  const fp = fingerprint(cfg.apiKey);
  return {
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    timeoutMs: cfg.timeoutMs,
    maxRetries: cfg.maxRetries,
    backoffMs: cfg.backoffMs,
    apiKeyFingerprint: fp,
  };
}

function fingerprint(secret: string): string {
  // Cheap stable 8-char fingerprint, never reversible.
  let h = 0;
  for (let i = 0; i < secret.length; i++) {
    h = (h * 31 + secret.charCodeAt(i)) >>> 0;
  }
  return `k-${h.toString(16).padStart(8, '0')}`;
}
