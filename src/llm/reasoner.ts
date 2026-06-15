// src/llm/reasoner.ts
// Hybrid pipeline: deterministic static analysis first, then a Cysic LLM
// pass that reasons over the STRUCTURED findings (not raw source) — this is
// the "facts over vibes" approach that cuts hallucination vs naive prompting
// (see docs/DESIGN.md).
//
// The LLM pass also implements the ADVERSARIAL false-positive filter from
// design doc §3: the model is explicitly asked to play devil's advocate on
// every finding, return a verdict + confidence, and is dropped when
// confidence is low or the verdict is "false_positive".

import type { CysicClient } from '../cysicClient.js';
import type { Finding, StaticAnalysisResult } from '../analysis/static.js';
import { defaultCysicClient } from '../cysicClient.js';
import { defaultCache, buildCacheKey, type ResponseCache } from '../cache.js';

export interface ReasonerOptions {
  cysic?: CysicClient;
  cache?: ResponseCache;
  /** Confidence floor below which a finding is dropped. Default 0.45. */
  confidenceFloor?: number;
  /** If true, skip the LLM pass and return the static findings as-is. */
  staticOnly?: boolean;
  /** If true, also include a second "refuter" pass for low-confidence findings. */
  adversarialRefuter?: boolean;
}

export interface LLMFinding {
  ruleId: string;
  category: string;
  title: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'informational';
  line: number;
  column: number;
  evidence: string;
  suggestion: string;
}

export interface ReasonerOutput {
  confirmedFindings: Finding[];
  rejectedFindings: { finding: Finding; reason: string }[];
  additionalFindings: Finding[];
  summary: string;
  rawModelOutput: string;
  /** Number of LLM calls made. */
  llmCalls: number;
  /** Number of cache hits. */
  cacheHits: number;
}

const SYSTEM_PROMPT = `You are a senior smart-contract security auditor. You will receive a Solidity source file and a set of STRUCTURED findings already produced by a deterministic static analyzer. Your job is to reason over those facts, not to re-derive them from raw text.

For every pre-extracted finding, return a verdict:
  - "confirmed"  : the finding is real and exploitable / worth fixing
  - "false_positive": the finding is wrong in this context
  - "uncertain"  : could go either way — supply a low confidence

For each verdict, give a confidence in [0,1] and a 1-2 sentence reason. Default to playing devil's advocate — try to find reasons the finding might be a false positive, and only confirm if those reasons fail.

You may also surface ADDITIONAL findings the static analyzer missed. Each additional finding MUST cite a specific line number from the source.

Be concise, technical, and avoid boilerplate.

Return JSON of the form:
{
  "verdicts": [
    { "id": "<static finding id>", "verdict": "confirmed|false_positive|uncertain", "confidence": <0..1>, "reasoning": "<short>" }
  ],
  "additionalFindings": [
    { "ruleId": "LLM-<3 chars>-<3 digits>", "category": "<short>", "title": "<short>",
      "description": "<1-2 sentences>", "severity": "critical|high|medium|low|informational",
      "line": <int>, "column": <int>, "evidence": "<source line>", "suggestion": "<short>" }
  ],
  "summary": "<1-2 paragraph plain-English summary of the contract and its risk posture>"
}
Return ONLY the JSON object, no surrounding markdown.`;

const REFUTER_PROMPT = `You are a skeptical refuter. You will receive one specific security finding about a Solidity contract, plus the source line it cites. Your only job is to decide if the finding should be REJECTED as a false positive.

Return JSON:
{
  "verdict": "confirm" | "reject",
  "confidence": <0..1>,
  "reasoning": "<1-2 sentences>"
}
Default to "reject" if you can articulate a plausible reason. Return ONLY the JSON.`;

interface Verdict {
  id: string;
  verdict: 'confirmed' | 'false_positive' | 'uncertain';
  confidence: number;
  reasoning: string;
}

interface AuditJSON {
  verdicts?: Verdict[];
  additionalFindings?: LLMFinding[];
  summary?: string;
}

/** Strip code fences / surrounding prose. Tolerant of LLM JSON quirks. */
function extractJsonObject(text: string): string {
  // Strip leading/trailing markdown fences.
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  }
  // Find first { and last }.
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) return t.slice(i, j + 1);
  return t;
}

function safeParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function evidenceFor(source: string, line: number): string {
  const lines = source.split(/\r?\n/);
  return (lines[Math.max(0, line - 1)] ?? '').trim();
}

function toFinding(
  llm: LLMFinding,
  staticResult: StaticAnalysisResult,
  source: string,
): Finding {
  const evidence = llm.evidence?.trim() || evidenceFor(source, llm.line);
  return {
    id: `LLM-${llm.ruleId}-${Math.random().toString(36).slice(2, 6)}`,
    ruleId: llm.ruleId,
    category: llm.category,
    title: llm.title,
    description: llm.description,
    severity: llm.severity,
    location: {
      line: llm.line,
      column: llm.column,
      evidence,
    },
    suggestion: llm.suggestion,
    locKey: `${staticResult.contracts[0] ?? 'source'}@${llm.line}:${llm.column}`,
  };
}

/**
 * Run the hybrid pipeline: static analysis + LLM reasoning + adversarial
 * false-positive filter.
 */
export async function reasonAboutContract(
  source: string,
  staticResult: StaticAnalysisResult,
  opts: ReasonerOptions = {},
): Promise<ReasonerOutput> {
  const cysic = opts.cysic ?? defaultCysicClient();
  const cache = opts.cache ?? defaultCache();
  const floor = opts.confidenceFloor ?? 0.45;
  const doAdversarial = opts.adversarialRefuter ?? true;

  const confirmed: Finding[] = [];
  const rejected: { finding: Finding; reason: string }[] = [];
  const additional: Finding[] = [];
  let rawOutput = '';
  let llmCalls = 0;
  let cacheHits = 0;

  if (opts.staticOnly) {
    return {
      confirmedFindings: staticResult.findings,
      rejectedFindings: [],
      additionalFindings: [],
      summary: 'Static-only mode — no LLM pass performed.',
      rawModelOutput: '',
      llmCalls: 0,
      cacheHits: 0,
    };
  }

  // ----- Pass 1: confirm/reject pre-extracted findings + add missed ones. -----
  const findingsForModel = staticResult.findings.map((f) => ({
    id: f.id,
    ruleId: f.ruleId,
    category: f.category,
    title: f.title,
    severity: f.severity,
    line: f.location.line,
    evidence: f.location.evidence,
  }));

  const userPrompt = [
    'STATIC FINDINGS (already extracted deterministically — do not re-derive from source):',
    JSON.stringify(findingsForModel, null, 2),
    '',
    'CONTRACT SOURCE:',
    '```solidity',
    source,
    '```',
  ].join('\n');

  const pass1Key = buildCacheKey({
    model: (cysic as unknown as { cfg: { model: string } }).cfg?.model ?? 'minimax-m3',
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
  });
  let pass1Text = cache.get(pass1Key) as string | undefined;
  if (pass1Text !== undefined) {
    cacheHits += 1;
  } else {
    pass1Text = await cysic.complete({ system: SYSTEM_PROMPT, prompt: userPrompt });
    cache.set(pass1Key, pass1Text);
    llmCalls += 1;
  }
  rawOutput = pass1Text;
  const parsed = safeParseJson<AuditJSON>(extractJsonObject(pass1Text)) ?? {};

  const verdictsById = new Map<string, Verdict>();
  for (const v of parsed.verdicts ?? []) {
    if (v && typeof v.id === 'string') verdictsById.set(v.id, v);
  }

  // Apply verdicts.
  for (const f of staticResult.findings) {
    const v = verdictsById.get(f.id);
    if (!v) {
      // No verdict — be conservative and keep the finding (don't drop on silence).
      confirmed.push(f);
      continue;
    }
    if (v.verdict === 'false_positive') {
      rejected.push({ finding: f, reason: v.reasoning || 'false positive per LLM' });
      continue;
    }
    if (v.verdict === 'uncertain' && v.confidence < floor) {
      // Drop low-confidence uncertain findings.
      rejected.push({ finding: f, reason: v.reasoning || 'low confidence' });
      continue;
    }
    confirmed.push(f);
  }

  // Additional findings (LMM-only).
  for (const llm of parsed.additionalFindings ?? []) {
    if (!Number.isInteger(llm.line) || llm.line < 1) continue;
    additional.push(toFinding(llm, staticResult, source));
  }

  // ----- Pass 2: adversarial refuter on uncertain / low-confidence findings. -----
  if (doAdversarial) {
    const lowConfidence = parsed.verdicts?.filter(
      (v) => v.verdict === 'uncertain' && v.confidence >= floor,
    ) ?? [];
    for (const v of lowConfidence) {
      const f = staticResult.findings.find((x) => x.id === v.id);
      if (!f) continue;
      const refuterPrompt = [
        'FINDING:',
        JSON.stringify({
          id: f.id,
          ruleId: f.ruleId,
          title: f.title,
          description: f.description,
          severity: f.severity,
          line: f.location.line,
          evidence: f.location.evidence,
          originalVerdict: v,
        }, null, 2),
        '',
        'SOURCE LINE:',
        '```solidity',
        f.location.evidence,
        '```',
      ].join('\n');
      const key = buildCacheKey({
        model: 'minimax-m3',
        system: REFUTER_PROMPT,
        prompt: refuterPrompt,
      });
      let txt = cache.get(key) as string | undefined;
      if (txt !== undefined) {
        cacheHits += 1;
      } else {
        txt = await cysic.complete({ system: REFUTER_PROMPT, prompt: refuterPrompt });
        cache.set(key, txt);
        llmCalls += 1;
      }
      const ref = safeParseJson<{ verdict?: string; confidence?: number; reasoning?: string }>(extractJsonObject(txt)) ?? {};
      if (ref.verdict === 'reject') {
        rejected.push({ finding: f, reason: `Refuted: ${ref.reasoning ?? v.reasoning}` });
        // Remove from confirmed if we had tentatively put it there.
        const idx = confirmed.indexOf(f);
        if (idx >= 0) confirmed.splice(idx, 1);
      }
    }
  }

  // Re-sort confirmed findings by severity then line.
  const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  const sortFn = (a: Finding, b: Finding) => {
    const sa = sevOrder[a.severity] ?? 5;
    const sb = sevOrder[b.severity] ?? 5;
    if (sa !== sb) return sa - sb;
    if (a.location.line !== b.location.line) return a.location.line - b.location.line;
    return a.ruleId.localeCompare(b.ruleId);
  };
  confirmed.sort(sortFn);
  additional.sort(sortFn);

  return {
    confirmedFindings: confirmed,
    rejectedFindings: rejected,
    additionalFindings: additional,
    summary: parsed.summary ?? '',
    rawModelOutput: rawOutput,
    llmCalls,
    cacheHits,
  };
}
