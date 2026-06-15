// src/analysis/static.ts
// Deterministic Solidity static analyzer. Runs pattern checks against the
// source AND (where possible) walks the AST to give findings precise
// source locations. This is the deterministic stage of the hybrid pipeline
// in docs/DESIGN.md — its structured findings are what the LLM reasons over.

import { parse, visit } from '@solidity-parser/parser';

type SolidityAST = ReturnType<typeof parse>;

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational';

export interface SourceLocation {
  /** 1-based line number. */
  line: number;
  /** 0-based column. */
  column: number;
  /** Original source line text, trimmed. */
  evidence: string;
}

export interface Finding {
  id: string;
  ruleId: string;
  category: string;
  title: string;
  description: string;
  severity: Severity;
  location: SourceLocation;
  /** Short, actionable fix hint the LLM can elaborate on. */
  suggestion: string;
  /** Stable identifier for the location — used to link before/after in closed-loop. */
  locKey: string;
}

export interface StaticAnalysisInput {
  source: string;
  /** Optional file name for evidence reporting. */
  filename?: string;
}

export interface StaticAnalysisResult {
  findings: Finding[];
  parseErrors: { line: number; column: number; message: string }[];
  /** Names of contracts / library / interface found, for context. */
  contracts: string[];
  /** Names of functions discovered. */
  functions: string[];
  /** Aggregated counts by severity — useful for risk scoring. */
  severityCounts: Record<Severity, number>;
}

const EMPTY_COUNTS: Record<Severity, number> = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  informational: 0,
};

/** Map rule id → severity for risk scoring. */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10,
  high: 6,
  medium: 3,
  low: 1,
  informational: 0,
};

/** Compute a coarse risk score 0..100 from findings. */
export function computeRiskScore(findings: Finding[]): number {
  if (findings.length === 0) return 0;
  const total = findings.reduce((acc, f) => acc + SEVERITY_WEIGHT[f.severity], 0);
  // Soft cap; sub-linear to keep the score stable as a small contract grows.
  return Math.min(100, Math.round(100 * (1 - Math.exp(-total / 12))));
}

const LOW_LEVEL_CALLS = new Set(['call', 'delegatecall', 'staticcall', 'send']);
const VALUE_METHODS = new Set(['transfer', 'send']);

/** Split source into 1-based lines for evidence reporting. */
function splitLines(source: string): string[] {
  return source.split(/\r?\n/);
}

function evidenceAt(sourceLines: string[], line: number, column: number): SourceLocation {
  const text = (sourceLines[Math.max(0, line - 1)] ?? '').trim();
  return { line: Math.max(1, line), column: Math.max(0, column), evidence: text };
}

function locKey(name: string, loc: SourceLocation): string {
  return `${name}@${loc.line}:${loc.column}`;
}

interface AnalyzerContext {
  source: string;
  lines: string[];
  filename: string;
  findings: Finding[];
  contracts: Set<string>;
  functions: Set<string>;
}

function makeId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function record(
  ctx: AnalyzerContext,
  ruleId: string,
  category: string,
  title: string,
  description: string,
  severity: Severity,
  loc: SourceLocation,
  suggestion: string,
  name: string,
): Finding {
  const finding: Finding = {
    id: makeId(ruleId),
    ruleId,
    category,
    title,
    description,
    severity,
    location: loc,
    suggestion,
    locKey: locKey(name, loc),
  };
  ctx.findings.push(finding);
  return finding;
}

/* -------------------------------------------------------------------------- */
/*                          Pattern checks (line-based)                       */
/* -------------------------------------------------------------------------- */

function checkPatterns(ctx: AnalyzerContext): void {
  const name = ctx.filename;
  for (let i = 0; i < ctx.lines.length; i++) {
    const raw = ctx.lines[i];
    const line = i + 1;
    const column = 0;

    // Floating pragma — informational, e.g. `pragma solidity ^0.8.0;`
    if (/^\s*pragma\s+solidity\s+\^/.test(raw)) {
      record(
        ctx,
        'SOL-PRAGMA-001',
        'best-practice',
        'Floating pragma',
        'Contract uses a floating pragma (^). Pin the pragma to a specific version so deployments are reproducible and auditor reasoning is well-defined.',
        'informational',
        evidenceAt(ctx.lines, line, column),
        'Pin to an exact compiler version, e.g. `pragma solidity 0.8.24;`.',
        name,
      );
    }

    // tx.origin used in equality / require / assert / if — high severity.
    if (/\btx\.origin\b/.test(raw) && /(==|!=|require|assert|if\s*\()/.test(raw)) {
      record(
        ctx,
        'SOL-AUTH-001',
        'authorization',
        'tx.origin used for authorization',
        'Using `tx.origin` for authorization is vulnerable to phishing: an intermediate contract can trick the user into calling a function that uses `tx.origin` to validate. Use `msg.sender` instead.',
        'high',
        evidenceAt(ctx.lines, line, column),
        'Replace `tx.origin` with `msg.sender` for authorization checks.',
        name,
      );
    } else if (/\btx\.origin\b/.test(raw)) {
      // tx.origin mentioned anywhere else — still flag, lower severity.
      record(
        ctx,
        'SOL-AUTH-001',
        'authorization',
        'tx.origin reference',
        '`tx.origin` reference detected. While not every use is exploitable, it usually indicates a phishing-vulnerable authorization pattern. Prefer `msg.sender`.',
        'medium',
        evidenceAt(ctx.lines, line, column),
        'Use `msg.sender` unless you have a specific reason to traverse the call stack.',
        name,
      );
    }

    // block.timestamp / now used inside conditional or as a source of randomness.
    if (/\b(block\.timestamp|now)\b/.test(raw)) {
      const isRandomness = /random|seed|lottery|raffle|chance/i.test(raw);
      record(
        ctx,
        'SOL-TIMESTAMP-001',
        'timestamp',
        isRandomness ? 'block.timestamp used as randomness source' : 'block.timestamp dependence',
        isRandomness
          ? '`block.timestamp` (or `now`) is manipulable by miners/validators within a small window. Never use it as a source of randomness.'
          : '`block.timestamp` can be influenced by validators within a short bound. Avoid using it for strict equality checks or tight time windows.',
        isRandomness ? 'medium' : 'low',
        evidenceAt(ctx.lines, line, column),
        isRandomness
          ? 'Use a verifiable randomness oracle (VRF / Chainlink VRF / drand) or commit-reveal scheme.'
          : 'If precise timing is required, use block numbers and document the tolerance window.',
        name,
      );
    }

    // block.number / blockhash for randomness.
    if (/\b(blockhash|block\.blockhash)\b/.test(raw) && /random|seed|lottery|raffle|chance|winner/i.test(raw)) {
      record(
        ctx,
        'SOL-RANDOMNESS-001',
        'randomness',
        'Weak on-chain randomness',
        'On-chain values (blockhash, block.timestamp, block.difficulty) can be predicted or influenced. Do not use them as the sole source of randomness for value-bearing decisions.',
        'medium',
        evidenceAt(ctx.lines, line, column),
        'Use Chainlink VRF, drand, or a commit-reveal scheme.',
        name,
      );
    }

    // selfdestruct / suicide
    if (/\b(selfdestruct|suicide)\b/.test(raw)) {
      record(
        ctx,
        'SOL-SELFDESTRUCT-001',
        'lifecycle',
        'selfdestruct usage',
        '`selfdestruct` is deprecated in Solidity 0.8.18+ and will be removed/limited in future EVM upgrades. Funds sent to a selfdestructed contract can be recovered by `SELFDESTRUCT` in same tx; the opcode is also subject to EIP-6780 changes.',
        'high',
        evidenceAt(ctx.lines, line, column),
        'Remove selfdestruct. If upgrade is needed, use a proxy / migration pattern.',
        name,
      );
    }

    // assembly block
    if (/\bassembly\s*(\(\s*"[^"]*"\s*\))?\s*\{/.test(raw)) {
      record(
        ctx,
        'SOL-ASSEMBLY-001',
        'low-level',
        'Inline assembly',
        'Inline assembly bypasses Solidity safety checks (overflow, type checks). Manual review required.',
        'medium',
        evidenceAt(ctx.lines, line, column),
        'Restrict to tightly audited, narrowly-scoped uses; document invariants; add invariant tests.',
        name,
      );
    }

    // Unchecked math in 0.8+ — `unchecked { ... }` block.
    if (/unchecked\s*\{/.test(raw)) {
      record(
        ctx,
        'SOL-MATH-001',
        'arithmetic',
        'unchecked arithmetic block',
        'Inside an `unchecked` block, Solidity 0.8+ will not revert on overflow/underflow. Make sure the math is provably safe for the operand ranges.',
        'low',
        evidenceAt(ctx.lines, line, column),
        'Confirm the operands can never overflow/underflow within the block; or remove `unchecked`.',
        name,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                              AST-based checks                              */
/* -------------------------------------------------------------------------- */

interface FnScope {
  name: string;
  startLine: number;
  calls: { loc: SourceLocation; member: string }[];
  writes: SourceLocation[];
  hasExternalCall: boolean;
  modifiers: string[];
  visibility: string | null;
  hasReentrancyGuard: boolean;
}

function fnKey(contract: string | null, fnName: string): string {
  return contract ? `${contract}.${fnName}` : fnName;
}

function walkAst(ctx: AnalyzerContext, ast: SolidityAST): void {
  const fnScopes = new Map<string, FnScope>();
  const fnKeys = new WeakMap<FnScope, string>();

  const makeScope = (name: string): FnScope => ({
    name,
    startLine: 0,
    calls: [],
    writes: [],
    hasExternalCall: false,
    modifiers: [],
    visibility: null,
    hasReentrancyGuard: false,
  });

  // First pass: collect functions, modifiers, contracts, and visibility info.
  visit(ast, {
    ContractDefinition: (node) => {
      ctx.contracts.add(node.name);
    },
    FunctionDefinition: (node) => {
      const name = node.name ?? '<anonymous>';
      const scope = makeScope(name);
      if (node.loc?.start) scope.startLine = node.loc.start.line;
      ctx.functions.add(name);
      fnScopes.set(name, scope);
      if (!node.visibility || node.visibility === 'default') {
        record(
          ctx,
          'SOL-VIS-001',
          'best-practice',
          'Missing function visibility',
          'No explicit visibility on a function. On Solidity ≤0.7 the default was `public`; even on 0.8+ this is bad style and may be flagged by linters.',
          'low',
          evidenceAt(ctx.lines, node.loc?.start?.line ?? 1, node.loc?.start?.column ?? 0),
          'Add `external`, `public`, `internal`, or `private` explicitly.',
          ctx.filename,
        );
      } else {
        scope.visibility = node.visibility;
      }
      scope.modifiers = node.modifiers
        .map((m) => (m.name ?? '').trim())
        .filter((s) => s.length > 0);
      scope.hasReentrancyGuard = scope.modifiers.some((m) =>
        /reentrancy|nonreentrant|mutex/i.test(m),
      );
    },
    ModifierDefinition: (node) => {
      if (node.name) ctx.functions.add(`modifier ${node.name}`);
    },
  });

  // Second pass: identify call sites and state writes per function.
  let currentContract: string | null = null;
  const fnStack: FnScope[] = [];

  visit(ast, {
    ContractDefinition: (node) => {
      currentContract = node.name;
    },
    'ContractDefinition:exit': () => {
      currentContract = null;
    },
    FunctionDefinition: (node) => {
      const name = node.name ?? '<anonymous>';
      const key = fnKey(currentContract, name);
      const scope = fnScopes.get(name) ?? (() => {
        const s = makeScope(name);
        fnScopes.set(name, s);
        return s;
      })();
      fnKeys.set(scope, key);
      fnStack.push(scope);
    },
    'FunctionDefinition:exit': () => {
      const popped = fnStack.pop();
      if (popped) {
        const key = fnKeys.get(popped) ?? popped.name;
        (popped as { _key?: string })._key = key;
        evaluateFunction(ctx, popped);
      }
    },
    FunctionCall: (node) => {
      const currentFn = fnStack[fnStack.length - 1];
      if (!currentFn) return;
      const expr = node.expression as { type?: string; memberName?: string } | undefined;
      if (!expr || expr.type !== 'MemberAccess') return;
      const member = expr.memberName;
      if (!member) return;
      if (LOW_LEVEL_CALLS.has(member) || VALUE_METHODS.has(member)) {
        const start = node.loc?.start;
        const loc: SourceLocation = start
          ? evidenceAt(ctx.lines, start.line, start.column)
          : evidenceAt(ctx.lines, 0, 0);
        currentFn.calls.push({ loc, member });
        currentFn.hasExternalCall = true;
      }
    },
    BinaryOperation: (node) => {
      const currentFn = fnStack[fnStack.length - 1];
      if (!currentFn) return;
      // Treat any assignment-shaped operator as a state write candidate.
      // `=` is plain assignment; `+=`, `-=`, etc. are compound assignments.
      const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);
      if (!ASSIGN_OPS.has(node.operator)) return;
      // And the LHS must be a storage-shaped access: simple identifier,
      // member access (struct), or index access (mapping/array). Locals
      // get included too — the conservative read is "any assignment could
      // matter" and the reentrancy check is meant to be cautious.
      const lhs = node.left;
      if (lhs.type !== 'Identifier' && lhs.type !== 'MemberAccess' && lhs.type !== 'IndexAccess' && lhs.type !== 'TupleExpression') {
        return;
      }
      const start = lhs.loc?.start;
      const loc: SourceLocation = start
        ? evidenceAt(ctx.lines, start.line, start.column)
        : evidenceAt(ctx.lines, 0, 0);
      currentFn.writes.push(loc);
    },
  });

  // Flush remaining scopes (free functions at file scope).
  for (const scope of fnScopes.values()) {
    if ((scope as { _key?: string })._key === undefined) {
      (scope as { _key?: string })._key = scope.name;
      if (scope.calls.length > 0 || scope.writes.length > 0) {
        evaluateFunction(ctx, scope);
      }
    }
  }
}

function evaluateFunction(ctx: AnalyzerContext, scope: FnScope): void {
  const name = (scope as { _key?: string })._key ?? scope.name;

  // Reentrancy: external call followed by state write.
  if (scope.hasExternalCall && scope.writes.length > 0 && !scope.hasReentrancyGuard) {
    const call = scope.calls[0];
    const write = scope.writes[0];
    if (call && write && write.line >= call.loc.line) {
      record(
        ctx,
        'SOL-REENTRANCY-001',
        'reentrancy',
        'Reentrancy: external call before state write',
        `Function '${name}' makes an external call via '${call.member}' before writing to state on line ${write.line}. A re-entrant call could observe stale state.`,
        'critical',
        call.loc,
        'Apply checks-effects-interactions: perform all state writes BEFORE the external call, or add a `nonReentrant` modifier (e.g. OpenZeppelin ReentrancyGuard).',
        ctx.filename,
      );
    }
  }

  // Unchecked low-level call return value.
  for (const call of scope.calls) {
    if (
      call.member === 'call' ||
      call.member === 'delegatecall' ||
      call.member === 'staticcall' ||
      call.member === 'send'
    ) {
      record(
        ctx,
        'SOL-LOWLEVEL-001',
        'low-level',
        `Unchecked ${call.member}() return value`,
        `Function '${name}' uses '.${call.member}()' which returns a boolean success flag. If the return value is not checked, a failed call is silently ignored.`,
        'high',
        call.loc,
        `Wrap with \`require(success, "...")\` or check the return tuple explicitly.`,
        ctx.filename,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                                   Public                                   */
/* -------------------------------------------------------------------------- */

/**
 * Run the full static analyzer on a Solidity source string. Always returns a
 * result — even if the source has parse errors (in which case the pattern
 * checks still run and `parseErrors` is populated).
 */
export function analyze(input: StaticAnalysisInput): StaticAnalysisResult {
  const source = input.source ?? '';
  const filename = input.filename ?? '<source>';
  const lines = splitLines(source);
  const ctx: AnalyzerContext = {
    source,
    lines,
    filename,
    findings: [],
    contracts: new Set(),
    functions: new Set(),
  };

  // Pattern checks first — they always run.
  checkPatterns(ctx);

  // Then AST checks.
  const parseErrors: { line: number; column: number; message: string }[] = [];
  try {
    const ast = parse(source, { loc: true, range: true, tolerant: true });
    if (ast.errors && ast.errors.length) {
      for (const e of ast.errors) {
        parseErrors.push({
          line: (e as { line?: number }).line ?? 0,
          column: (e as { column?: number }).column ?? 0,
          message: (e as { message?: string }).message ?? 'parse error',
        });
      }
    }
    walkAst(ctx, ast);
  } catch (err) {
    parseErrors.push({
      line: 0,
      column: 0,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // Severity counts.
  const severityCounts: Record<Severity, number> = { ...EMPTY_COUNTS };
  for (const f of ctx.findings) severityCounts[f.severity] += 1;

  // Stable sort: severity desc, then line, then ruleId.
  const sevOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
  ctx.findings.sort((a, b) => {
    if (sevOrder[a.severity] !== sevOrder[b.severity]) return sevOrder[a.severity] - sevOrder[b.severity];
    if (a.location.line !== b.location.line) return a.location.line - b.location.line;
    return a.ruleId.localeCompare(b.ruleId);
  });

  return {
    findings: ctx.findings,
    parseErrors,
    contracts: Array.from(ctx.contracts),
    functions: Array.from(ctx.functions),
    severityCounts,
  };
}
