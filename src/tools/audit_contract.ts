// src/tools/audit_contract.ts
// audit_contract — runs the hybrid pipeline (static + LLM + adversarial FP
// filter) and returns a ranked vulnerability report. Accepts either a
// {source} inline or an {address, chain, rpcUrl} tuple that we fetch from
// a chain explorer.

import { z } from 'zod';
import { analyze, computeRiskScore, type Finding } from '../analysis/static.js';
import { reasonAboutContract, type ReasonerOutput } from '../llm/reasoner.js';
import { defaultAuditStore, type AuditStore } from '../audits/store.js';
import { fetchSource, SourceFetchError } from '../onchain/fetchSource.js';
import {
  jsonText,
  errorResult,
  validateInput,
  type ToolDescriptor,
  type ToolHandlerResult,
  type TextContent,
} from './types.js';

const SourceInputSchema = z.object({
  source: z.string().min(1, 'source must be a non-empty Solidity source string'),
  filename: z.string().optional(),
});

const AddressInputSchema = z.object({
  address: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/u, 'address must be 0x-prefixed 40 hex chars'),
  chain: z.string().min(1).default('ethereum'),
  rpcUrl: z.string().url().optional(),
  apiKey: z.string().optional(),
});

const AuditInputSchema = z.union([SourceInputSchema, AddressInputSchema]);

export const auditContractTool: ToolDescriptor = {
  name: 'audit_contract',
  description:
    'Audit a Solidity contract. Pass EITHER { source, filename? } OR { address, chain, rpcUrl?, apiKey? } (one of source / address is required). Returns a ranked vulnerability report produced by the hybrid static + LLM pipeline with an adversarial false-positive filter.',
  inputSchema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Inline Solidity source code.',
      },
      filename: {
        type: 'string',
        description: 'Optional label used in evidence lines.',
      },
      address: {
        type: 'string',
        description: 'On-chain contract address (0x…). Use with chain.',
      },
      chain: {
        type: 'string',
        description:
          'Etherscan-compatible chain identifier (ethereum, polygon, bsc, arbitrum, optimism, base, sepolia, …).',
        default: 'ethereum',
      },
      rpcUrl: {
        type: 'string',
        description: 'Optional RPC URL (kept for symmetry; source is fetched from the explorer).',
      },
      apiKey: {
        type: 'string',
        description:
          'Optional Etherscan-compatible API key. Overrides the CHAIN_EXPLORER_API_KEY env var.',
      },
    },
    required: [],
    additionalProperties: false,
  },
};

function saveAudit(
  input: Parameters<AuditStore['save']>[0],
  store: AuditStore,
): ReturnType<AuditStore['save']> {
  return store.save(input);
}

export interface AuditResult {
  id: string;
  riskScore: number;
  staticFindings: number;
  confirmedFindings: Finding[];
  rejectedFindings: { finding: Finding; reason: string }[];
  additionalFindings: Finding[];
  summary: string;
  contracts: string[];
  functions: string[];
  llmCalls: number;
  cacheHits: number;
  source: string;
  filename?: string;
  address?: string;
  chain?: string;
}

export async function handleAuditContract(
  rawInput: unknown,
  deps: { store?: AuditStore } = {},
): Promise<ToolHandlerResult> {
  let input: z.output<typeof AuditInputSchema>;
  try {
    input = validateInput(AuditInputSchema, rawInput, 'audit_contract');
  } catch (err) {
    return errorResult('Invalid input', err instanceof Error ? err.message : String(err));
  }

  let source: string;
  let filename: string | undefined;
  let address: string | undefined;
  let chain: string | undefined;

  if ('source' in input) {
    source = input.source;
    filename = input.filename;
  } else {
    try {
      const fetched = await fetchSource(input);
      source = fetched.source;
      filename = fetched.contractName ?? `${fetched.chain}:${fetched.address}`;
      address = fetched.address;
      chain = fetched.chain;
    } catch (err) {
      if (err instanceof SourceFetchError) {
        return errorResult(`Could not fetch source for ${input.address}`, {
          code: err.code,
          message: err.message,
        });
      }
      return errorResult('Failed to fetch source from explorer', err instanceof Error ? err.message : String(err));
    }
  }

  // 1. Static analysis — deterministic, always runs.
  const staticResult = analyze({ source, filename });
  const riskBefore = computeRiskScore(staticResult.findings);

  // 2. Hybrid: LLM reasons over the structured findings (adversarial FP filter).
  let reasoner: ReasonerOutput;
  try {
    reasoner = await reasonAboutContract(source, staticResult);
  } catch (err) {
    return errorResult('LLM reasoning failed', err instanceof Error ? err.message : String(err));
  }

  // 3. Persist the report.
  const store = deps.store ?? defaultAuditStore();
  const report = await saveAudit(
    {
      source,
      filename,
      address,
      chain,
      staticAnalysis: staticResult,
      confirmedFindings: reasoner.confirmedFindings,
      rejectedFindings: reasoner.rejectedFindings,
      summary: reasoner.summary,
      notes: reasoner.additionalFindings.map((f) => `[${f.ruleId}] ${f.title} (L${f.location.line})`),
      model: process.env.CYSIC_MODEL ?? 'minimax-m3',
    },
    store,
  );

  // 4. Build the response payload.
  const riskAfter = computeRiskScore(
    [...reasoner.confirmedFindings, ...reasoner.additionalFindings],
  );
  const result: AuditResult = {
    id: report.id,
    riskScore: riskAfter,
    staticFindings: staticResult.findings.length,
    confirmedFindings: [...reasoner.confirmedFindings, ...reasoner.additionalFindings],
    rejectedFindings: reasoner.rejectedFindings,
    additionalFindings: reasoner.additionalFindings,
    summary: reasoner.summary,
    contracts: staticResult.contracts,
    functions: staticResult.functions,
    llmCalls: reasoner.llmCalls,
    cacheHits: reasoner.cacheHits,
    source,
    filename,
    address,
    chain,
  };
  void riskBefore; // (currently unused in payload, but useful for logging)

  const payload: { audit: AuditResult; resourceUri: string } = {
    audit: result,
    resourceUri: `contract://audits/${report.id}`,
  };
  return { content: [jsonText(payload) satisfies TextContent] };
}
