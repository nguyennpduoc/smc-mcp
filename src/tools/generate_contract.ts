// src/tools/generate_contract.ts
// generate_contract — produce Solidity from a natural-language spec, then
// run the static analyzer on the output so the user sees any pre-shipping
// concerns immediately.

import { z } from 'zod';
import { analyze, type Finding } from '../analysis/static.js';
import { defaultCysicClient, type CysicClient } from '../cysicClient.js';
import {
  jsonText,
  errorResult,
  validateInput,
  type ToolDescriptor,
  type ToolHandlerResult,
  type TextContent,
} from './types.js';

const InputSchema = z.object({
  spec: z.string().min(10, 'spec must be a non-trivial natural-language description'),
  /** Optional Solidity version pin in the generated pragma. */
  solidityVersion: z.string().regex(/^\d+\.\d+\.\d+$/u).default('0.8.24'),
  /** Optional license identifier. */
  license: z.string().default('MIT'),
  /** When true, the response includes the static analysis of the generated code. */
  preAudit: z.boolean().default(true),
});

export const generateContractTool: ToolDescriptor = {
  name: 'generate_contract',
  description:
    'Generate Solidity from a natural-language spec. Returns the source plus a static analysis of the generated code so you can see obvious issues before deploying.',
  inputSchema: {
    type: 'object',
    properties: {
      spec: {
        type: 'string',
        description: 'Natural-language description of what the contract should do.',
      },
      solidityVersion: {
        type: 'string',
        description: 'Solidity version for the pragma. Default 0.8.24.',
        default: '0.8.24',
      },
      license: {
        type: 'string',
        description: 'SPDX license identifier. Default MIT.',
        default: 'MIT',
      },
      preAudit: {
        type: 'boolean',
        description: 'Run the static analyzer on the generated code. Default true.',
        default: true,
      },
    },
    required: ['spec'],
    additionalProperties: false,
  },
};

const SYSTEM = `You are a senior Solidity engineer. Given a natural-language spec, produce a complete, ready-to-compile Solidity contract.

Requirements:
  - Use the specified pragma solidity version.
  - Use the specified SPDX license identifier.
  - Apply checks-effects-interactions; use a ReentrancyGuard for any function that makes external calls after state writes.
  - Use msg.sender for authorization, never tx.origin.
  - Wrap low-level .call/.delegatecall/.staticcall return values with require.
  - Use NatSpec comments on public/external functions and state variables.
  - Include events for all state-changing operations.
  - Add a brief comment block at the top of the contract describing its purpose.

Return ONLY the Solidity source — no markdown, no code fences, no preamble.`;

export interface GenerateResult {
  source: string;
  preAudit?: {
    parseErrors: { line: number; column: number; message: string }[];
    staticFindings: Finding[];
    severityCounts: Record<string, number>;
    riskScore: number;
  };
  spec: string;
  solidityVersion: string;
  license: string;
}

export async function handleGenerateContract(
  rawInput: unknown,
  deps: { cysic?: CysicClient } = {},
): Promise<ToolHandlerResult> {
  let input: z.output<typeof InputSchema>;
  try {
    input = validateInput(InputSchema, rawInput, 'generate_contract');
  } catch (err) {
    return errorResult('Invalid input', err instanceof Error ? err.message : String(err));
  }

  const cysic = deps.cysic ?? defaultCysicClient();
  const prompt = [
    'SPEC:',
    input.spec,
    '',
    'PRAGMA VERSION:',
    input.solidityVersion,
    '',
    'LICENSE:',
    input.license,
  ].join('\n');

  let raw: string;
  try {
    raw = await cysic.complete({ system: SYSTEM, prompt });
  } catch (err) {
    return errorResult('LLM call failed', err instanceof Error ? err.message : String(err));
  }
  const source = stripFences(raw);

  const result: GenerateResult = {
    source,
    spec: input.spec,
    solidityVersion: input.solidityVersion,
    license: input.license,
  };
  if (input.preAudit) {
    const analysis = analyze({ source });
    const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
    let sum = 0;
    const w = { critical: 10, high: 6, medium: 3, low: 1, informational: 0 } as const;
    for (const f of analysis.findings) {
      counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      sum += w[f.severity];
    }
    const risk = analysis.findings.length === 0 ? 0 : Math.min(100, Math.round(100 * (1 - Math.exp(-sum / 12))));
    result.preAudit = {
      parseErrors: analysis.parseErrors,
      staticFindings: analysis.findings,
      severityCounts: counts,
      riskScore: risk,
    };
  }
  return { content: [jsonText(result) satisfies TextContent] };
}

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:solidity)?\s*/i, '').replace(/```\s*$/, '');
  }
  return t.trim();
}
