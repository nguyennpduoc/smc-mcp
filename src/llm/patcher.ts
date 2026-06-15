// src/llm/patcher.ts
// LLM-driven patcher for the closed-loop self-audit (design doc §2).
//
// Given a contract source and one Finding, the patcher asks the LLM to
// return a patched version of the ENTIRE file. We do a textual diff
// between original and patched, then re-run the static analyzer + AI
// audit on the patched code to verify the finding was actually fixed and
// no new ones were introduced.

import type { Finding } from '../analysis/static.js';
import type { CysicClient } from '../cysicClient.js';
import { defaultCysicClient } from '../cysicClient.js';

export interface PatchResult {
  patched: string;
  rawModelOutput: string;
}

const PATCH_SYSTEM_PROMPT = `You are a senior Solidity engineer. You will be given:
  1. The full source of a Solidity contract.
  2. ONE specific security finding the audit produced (rule, severity, line, description, suggestion).
Your job: return a NEW version of the contract that fixes the finding with the smallest reasonable change. Apply checks-effects-interactions, add reentrancy guards, switch tx.origin -> msg.sender, wrap low-level call return values, etc. as appropriate.

Rules:
  - Preserve pragma, imports, and any code unrelated to the fix.
  - If you add a new state variable, place it near the other state variables.
  - If you import OpenZeppelin, add the import at the top alongside the others.
  - Do not introduce new external dependencies unless necessary; OpenZeppelin is acceptable.
  - Return ONLY the full patched Solidity source — no markdown, no explanation, no code fences.`;

export async function generatePatch(
  source: string,
  finding: Finding,
  cysic: CysicClient = defaultCysicClient(),
): Promise<PatchResult> {
  const userPrompt = [
    'CONTRACT SOURCE:',
    '```solidity',
    source,
    '```',
    '',
    'FINDING TO FIX:',
    JSON.stringify({
      id: finding.id,
      ruleId: finding.ruleId,
      severity: finding.severity,
      category: finding.category,
      title: finding.title,
      description: finding.description,
      line: finding.location.line,
      evidence: finding.location.evidence,
      suggestion: finding.suggestion,
    }, null, 2),
  ].join('\n');
  const raw = await cysic.complete({ system: PATCH_SYSTEM_PROMPT, prompt: userPrompt });
  const patched = stripFences(raw);
  return { patched, rawModelOutput: raw };
}

function stripFences(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:solidity)?\s*/i, '').replace(/```\s*$/, '');
  }
  return t.trim();
}
