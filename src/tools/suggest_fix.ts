// src/tools/suggest_fix.ts
// suggest_fix — given a source + finding_id, generates a patch with the
// LLM and re-runs the hybrid pipeline on the patched code to produce a
// verified before/after. This is design-doc §2 (closed-loop self-audit).

import { z } from 'zod';
import { analyze, computeRiskScore, type Finding } from '../analysis/static.js';
import { reasonAboutContract, type ReasonerOutput } from '../llm/reasoner.js';
import { generatePatch } from '../llm/patcher.js';
import { diffToUnified } from '../util/diff.js';
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
  finding_id: z.string().min(1),
  filename: z.string().optional(),
});

export const suggestFixTool: ToolDescriptor = {
  name: 'suggest_fix',
  description:
    'Given a source contract and a finding_id (from audit_contract), generate a patch and re-audit the patched code. Returns the unified diff, the new static analysis, and a before/after risk score.',
  inputSchema: {
    type: 'object',
    properties: {
      source: { type: 'string', description: 'Original Solidity source.' },
      finding_id: {
        type: 'string',
        description: 'Finding id from a previous audit_contract call.',
      },
      filename: { type: 'string', description: 'Optional label for the source file.' },
    },
    required: ['source', 'finding_id'],
    additionalProperties: false,
  },
};

export interface SuggestFixResult {
  finding: Finding;
  patch: {
    diff: string;
    patchedSource: string;
  };
  reAudit: {
    staticFindings: number;
    confirmedFindings: number;
    rejectedFindings: number;
    additionalFindings: number;
    riskScore: number;
    summary: string;
  };
  before: { riskScore: number; staticFindings: number };
  /** true if the original finding no longer appears in the patched audit. */
  findingResolved: boolean;
  /** new finding ids introduced by the patch (regression indicator). */
  newFindingIds: string[];
  llmCalls: number;
  cacheHits: number;
}

export async function handleSuggestFix(
  rawInput: unknown,
  deps: { cysic?: CysicClient } = {},
): Promise<ToolHandlerResult> {
  let input: z.output<typeof InputSchema>;
  try {
    input = validateInput(InputSchema, rawInput, 'suggest_fix');
  } catch (err) {
    return errorResult('Invalid input', err instanceof Error ? err.message : String(err));
  }

  const cysic = deps.cysic ?? defaultCysicClient();

  // 1. Run the static analyzer to find the finding by id.
  const staticBefore = analyze({ source: input.source, filename: input.filename });
  const finding = staticBefore.findings.find((f) => f.id === input.finding_id);
  if (!finding) {
    return errorResult(
      `finding_id "${input.finding_id}" not found in current static analysis of the source. Run audit_contract first to get a fresh list of finding ids.`,
      { available: staticBefore.findings.map((f) => f.id) },
    );
  }
  const riskBefore = computeRiskScore(staticBefore.findings);

  // 2. Generate a patch.
  let patch;
  try {
    patch = await generatePatch(input.source, finding, cysic);
  } catch (err) {
    return errorResult('Patch generation failed', err instanceof Error ? err.message : String(err));
  }
  if (!patch.patched || patch.patched.trim().length === 0) {
    return errorResult('LLM returned an empty patch — refusing to apply');
  }

  // 3. Re-run static + AI on the patched code.
  const staticAfter = analyze({ source: patch.patched, filename: input.filename });
  let reAudit: ReasonerOutput;
  try {
    reAudit = await reasonAboutContract(patch.patched, staticAfter, { cysic });
  } catch (err) {
    return errorResult('Re-audit failed', err instanceof Error ? err.message : String(err));
  }

  // 4. Compute before/after.
  const allConfirmedAfter = [...reAudit.confirmedFindings, ...reAudit.additionalFindings];
  const riskAfter = computeRiskScore(allConfirmedAfter);
  const findingResolved = !staticAfter.findings.some(
    (f) => f.ruleId === finding.ruleId && f.location.line === finding.location.line,
  );
  const newFindings = staticAfter.findings.filter(
    (f) => !staticBefore.findings.some((b) => b.ruleId === f.ruleId && b.location.line === f.location.line),
  );

  const result: SuggestFixResult = {
    finding,
    patch: {
      diff: diffToUnified(input.source, patch.patched),
      patchedSource: patch.patched,
    },
    reAudit: {
      staticFindings: staticAfter.findings.length,
      confirmedFindings: reAudit.confirmedFindings.length,
      rejectedFindings: reAudit.rejectedFindings.length,
      additionalFindings: reAudit.additionalFindings.length,
      riskScore: riskAfter,
      summary: reAudit.summary,
    },
    before: { riskScore: riskBefore, staticFindings: staticBefore.findings.length },
    findingResolved,
    newFindingIds: newFindings.map((f) => f.id),
    llmCalls: 1 + reAudit.llmCalls,
    cacheHits: reAudit.cacheHits,
  };

  return { content: [jsonText(result) satisfies TextContent] };
}
