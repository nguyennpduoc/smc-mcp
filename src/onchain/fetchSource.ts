// src/onchain/fetchSource.ts
// Fetch a contract's source from a chain explorer. Supports the
// Etherscan-compatible API used by Etherscan, Polygonscan, Basescan,
// Arbiscan, Optimism, BNB, etc.
//
// For full source code, most explorers require an `apikey` query param.
// We accept it via the input (`apiKey`) or env (`CHAIN_EXPLORER_API_KEY`).
// Without it, public endpoints still work for rate-limited, low-volume use
// but will likely fail under load.

import axios, { type AxiosInstance } from 'axios';
import { z } from 'zod';

const CHAIN_BASE: Record<string, string> = {
  ethereum: 'https://api.etherscan.io/api',
  mainnet: 'https://api.etherscan.io/api',
  polygon: 'https://api.polygonscan.com/api',
  bsc: 'https://api.bscscan.com/api',
  bnb: 'https://api.bscscan.com/api',
  arbitrum: 'https://api.arbiscan.io/api',
  arb: 'https://api.arbiscan.io/api',
  optimism: 'https://api-optimistic.etherscan.io/api',
  op: 'https://api-optimistic.etherscan.io/api',
  base: 'https://api.basescan.org/api',
  sepolia: 'https://api-sepolia.etherscan.io/api',
  holesky: 'https://api-holesky.etherscan.io/api',
};

export const AddressInputSchema = z.object({
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, 'address must be a 0x-prefixed 40-hex string'),
  chain: z.string().min(1).default('ethereum'),
  // Kept for symmetry with the MCP tool spec; we don't use it server-side
  // because source code lives on the explorer, not the RPC.
  rpcUrl: z.string().url().optional(),
  // Optional explicit explorer key (overrides env).
  apiKey: z.string().optional(),
});

export type AddressInput = z.infer<typeof AddressInputSchema>;

export interface FetchedSource {
  address: string;
  chain: string;
  source: string;
  /** Name reported by the explorer, if any. */
  contractName?: string;
  /** True if the contract is verified on the explorer. */
  verified: boolean;
}

export class SourceFetchError extends Error {
  readonly code: 'unknown_chain' | 'not_verified' | 'http' | 'malformed';
  readonly status?: number;
  constructor(code: SourceFetchError['code'], message: string, status?: number) {
    super(message);
    this.name = 'SourceFetchError';
    this.code = code;
    this.status = status;
  }
}

export interface FetcherOptions {
  http?: AxiosInstance;
  env?: NodeJS.ProcessEnv;
}

export async function fetchSource(
  input: AddressInput,
  opts: FetcherOptions = {},
): Promise<FetchedSource> {
  const parsed = AddressInputSchema.parse(input);
  const base = CHAIN_BASE[parsed.chain.toLowerCase()];
  if (!base) {
    throw new SourceFetchError(
      'unknown_chain',
      `unknown chain "${parsed.chain}". Supported: ${Object.keys(CHAIN_BASE).join(', ')}`,
    );
  }
  const apiKey = parsed.apiKey ?? opts.env?.CHAIN_EXPLORER_API_KEY;
  const http =
    opts.http ??
    axios.create({
      timeout: 15000,
      validateStatus: () => true,
    });

  const url = `${base}?module=contract&action=getsourcecode&address=${parsed.address}${
    apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : ''
  }`;

  const res = await http.get(url).catch((err: unknown) => {
    throw new SourceFetchError(
      'http',
      `failed to reach explorer: ${err instanceof Error ? err.message : String(err)}`,
    );
  });

  if (res.status < 200 || res.status >= 300) {
    throw new SourceFetchError('http', `explorer returned status ${res.status}`, res.status);
  }
  const data = res.data as {
    status?: string;
    message?: string;
    result?: Array<{ SourceCode?: string; ContractName?: string; ABI?: string }>;
  };
  if (data.status !== '1' || !Array.isArray(data.result) || data.result.length === 0) {
    throw new SourceFetchError('http', `explorer error: ${data.message ?? 'unknown'}`);
  }
  const first = data.result[0];
  const sourceCode = first?.SourceCode;
  if (!sourceCode || sourceCode.length === 0) {
    throw new SourceFetchError(
      'not_verified',
      `contract at ${parsed.address} on ${parsed.chain} is not verified on the explorer — cannot fetch source`,
    );
  }
  // Etherscan returns a JSON-stringified object when the contract has
  // multiple files. Try to parse and reconstruct.
  const flat = flattenSourceCode(sourceCode);
  return {
    address: parsed.address,
    chain: parsed.chain,
    source: flat,
    contractName: first?.ContractName,
    verified: true,
  };
}

function flattenSourceCode(raw: string): string {
  // If the response is a JSON object string, Etherscan encodes it with
  // double-encoded quotes. Try once.
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as { sources?: Record<string, { content?: string }> };
      if (obj.sources) {
        const out: string[] = [];
        for (const [path, file] of Object.entries(obj.sources)) {
          out.push(`// ---- ${path} ----`);
          out.push(file.content ?? '');
        }
        return out.join('\n');
      }
    } catch {
      // fall through
    }
  }
  return raw;
}
