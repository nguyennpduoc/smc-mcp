// src/util/diff.ts
// Minimal line-level diff. Returns a unified-diff-like representation that
// the MCP tools can show to users. We don't need LCS; a simple O(n*m) is
// fine for the small file sizes we deal with (Solidity contracts are
// typically < 1k lines).

export type DiffLineKind = 'context' | 'add' | 'remove';

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the "before" file (0 if N/A). */
  oldLine: number;
  /** 1-based line number in the "after" file (0 if N/A). */
  newLine: number;
  text: string;
}

/** Myers-style line diff — small inputs only, but correct. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  // dp[i][j] = edit distance between a[0..i) and b[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) dp[i][j] = dp[i - 1][j - 1];
      else dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  // Backtrack to produce the edit script.
  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      out.push({ kind: 'context', oldLine: i, newLine: j, text: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j - 1] <= dp[i - 1][j] && dp[i - 1][j - 1] <= dp[i][j - 1]) {
      out.push({ kind: 'remove', oldLine: i, newLine: 0, text: a[i - 1] });
      out.push({ kind: 'add', oldLine: 0, newLine: j, text: b[j - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] <= dp[i][j - 1]) {
      out.push({ kind: 'remove', oldLine: i, newLine: 0, text: a[i - 1] });
      i--;
    } else {
      out.push({ kind: 'add', oldLine: 0, newLine: j, text: b[j - 1] });
      j--;
    }
  }
  while (i > 0) {
    out.push({ kind: 'remove', oldLine: i, newLine: 0, text: a[i - 1] });
    i--;
  }
  while (j > 0) {
    out.push({ kind: 'add', oldLine: 0, newLine: j, text: b[j - 1] });
    j--;
  }
  return out.reverse();
}

export function diffToUnified(before: string, after: string, context = 3): string {
  const lines = lineDiff(before, after);
  const out: string[] = ['--- before', '+++ after'];
  // Group into hunks of `context` unchanged lines around each change.
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind === 'context') {
      i++;
      continue;
    }
    // find start of hunk: walk back up to `context` context lines
    let hunkStart = i;
    let ctx = 0;
    while (hunkStart > 0 && ctx < context) {
      if (lines[hunkStart - 1].kind === 'context') {
        hunkStart--;
        ctx++;
      } else {
        break;
      }
    }
    // find end of hunk
    let hunkEnd = i;
    let trailingCtx = 0;
    while (hunkEnd < lines.length && (lines[hunkEnd].kind !== 'context' || trailingCtx < context)) {
      if (lines[hunkEnd].kind === 'context') trailingCtx++;
      else trailingCtx = 0;
      hunkEnd++;
    }
    // emit hunk header
    const slice = lines.slice(hunkStart, hunkEnd);
    let oldCount = 0;
    let newCount = 0;
    let oldStart = 0;
    let newStart = 0;
    for (const l of slice) {
      if (l.kind === 'context') {
        oldCount++;
        newCount++;
        if (!oldStart) oldStart = l.oldLine;
        if (!newStart) newStart = l.newLine;
      } else if (l.kind === 'remove') {
        oldCount++;
        if (!oldStart) oldStart = l.oldLine;
      } else {
        newCount++;
        if (!newStart) newStart = l.newLine;
      }
    }
    out.push(`@@ -${oldStart || 0},${oldCount} +${newStart || 0},${newCount} @@`);
    for (const l of slice) {
      const prefix = l.kind === 'add' ? '+' : l.kind === 'remove' ? '-' : ' ';
      out.push(`${prefix}${l.text}`);
    }
    i = hunkEnd;
  }
  return out.join('\n');
}
