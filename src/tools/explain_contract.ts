// src/tools/explain_contract.ts
// explain_contract — returns a plain-English summary of a Solidity contract.
// Uses the static analyzer to extract structured facts (contracts,
// functions, findings) which it then hands to the LLM as facts to
// summarize.

import { z } from 'zod';
import { analyze } from '../analysis/static.js';
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
  source: z.string().min(1),
  filename: z.string().optional(),
});

export const explainContractTool: ToolDescriptor = {
  name: 'explain_contract',
  description:
    'Explain a Solidity contract in plain English. Returns a summary covering purpose, key state, external surface, and any concerns spotted by the static analyzer.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Solidity source code.' },
      filename: { type: 'string', description: 'Optional label used in evidence lines.' },
    },
    required: ['source'],
    additionalProperties: false,
  },
};

const SYSTEM = `You are a senior smart-contract engineer. You will be given:
  1. STRUCTURED FACTS about a Solidity contract (contract names, function names, the static analysis findings).
  2. The full source.

Write a plain-English explanation covering:
  - What the contract does (purpose and core invariants).
  - Public / external surface: who can call what, with what value, and what changes.
  - Key state variables and their roles.
  - Notable security concerns (cite the static finding ids if relevant).
  - Upgrade / proxy / admin powers if any.

Be concise (3-5 short paragraphs) and concrete. Avoid boilerplate phrases like "this is a smart contract".`;

export interface ExplainResult {
  summary: string;
  contracts: string[];
  functions: string[];
  notableFindings: { ruleId: string; title: string; severity: string; line: number }[];
  filename?: string;
}

export async function handleExplainContract(
  rawInput: unknown,
  deps: { cysic?: CysicClient } = {},
): Promise<ToolHandlerResult> {
  let input: z.output<typeof InputSchema>;
  try {
    input = validateInput(InputSchema, rawInput, 'explain_contract');
  } catch (err) {
    return errorResult('Invalid input', err instanceof Error ? err.message : String(err));
  }

  const staticResult = analyze({ source: input.source, filename: input.filename });
  const notableFindings = staticResult.findings
    .filter((f) => f.severity === 'critical' || f.severity === 'high' || f.severity === 'medium')
    .map((f) => ({
      ruleId: f.ruleId,
      title: f.title,
      severity: f.severity,
      line: f.location.line,
    }));

  const userPrompt = [
    'STRUCTURED FACTS:',
    JSON.stringify(
      {
        contracts: staticResult.contracts,
        functions: staticResult.functions,
        notableFindings,
        parseErrors: staticResult.parseErrors,
      },
      null,
      2,
    ),
    '',
    'CONTRACT SOURCE:',
    '```solidity',
    input.source,
    '```',
  ].join('\n');

  let summary: string;
  try {
    const cysic = deps.cysic ?? defaultCysicClient();
    summary = await cysic.complete({ system: SYSTEM, prompt: userPrompt });
  } catch (err) {
    return errorResult('LLM call failed', err instanceof Error ? err.message : String(err));
  }

  const result: ExplainResult = {
    summary,
    contracts: staticResult.contracts,
    functions: staticResult.functions,
    notableFindings,
    filename: input.filename,
  };
  return { content: [jsonText(result) satisfies TextContent] };
}
