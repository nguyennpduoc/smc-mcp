// src/audits/store.ts
// Persistent store for audit reports. Exposed via the MCP resource
// `contract://audits/{id}`. Persisted to .audits/ as JSON files so reports
// survive server restarts.

import { mkdir, readFile, readdir, writeFile, unlink, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { Finding, StaticAnalysisResult } from '../analysis/static.js';

export interface AuditReport {
  id: string;
  /** sha256 of the contract source. */
  sourceHash: string;
  /** The original source, for the closed-loop re-audit reference. */
  source: string;
  filename?: string;
  /** Optional — set when the audit was tied to an on-chain address. */
  address?: string;
  chain?: string;
  createdAt: string;
  /** The static analysis result. */
  staticAnalysis: StaticAnalysisResult;
  /** Findings after the adversarial false-positive filter. */
  confirmedFindings: Finding[];
  /** Findings dropped by the adversarial pass (kept for auditability). */
  rejectedFindings: { finding: Finding; reason: string }[];
  /** Total risk score 0..100, before. */
  riskScore: number;
  /** Plain-English summary written by the LLM. */
  summary: string;
  /** Free-form notes the model added. */
  notes: string[];
  /** Model id used. */
  model: string;
}

export interface SaveAuditInput {
  source: string;
  filename?: string;
  address?: string;
  chain?: string;
  staticAnalysis: StaticAnalysisResult;
  confirmedFindings: Finding[];
  rejectedFindings: { finding: Finding; reason: string }[];
  summary: string;
  notes: string[];
  model: string;
  /** Optional explicit id (e.g. for a closed-loop re-audit re-using the same id). */
  id?: string;
}

export class AuditStore {
  private readonly dir: string;

  constructor(dir = '.audits') {
    this.dir = resolve(process.cwd(), dir);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  /** Build a stable id from a source hash plus a random suffix to keep ids unique. */
  static buildId(source: string): string {
    const h = createHash('sha256').update(source).digest('hex').slice(0, 10);
    const r = randomBytes(3).toString('hex');
    return `${h}-${r}`;
  }

  async save(input: SaveAuditInput): Promise<AuditReport> {
    await this.ensureDir();
    const id = input.id ?? AuditStore.buildId(input.source);
    const sourceHash = createHash('sha256').update(input.source).digest('hex');
    const total = input.confirmedFindings.length + input.rejectedFindings.length;
    // Cheap risk score from confirmed findings only.
    const weights = { critical: 10, high: 6, medium: 3, low: 1, informational: 0 } as const;
    const sum = input.confirmedFindings.reduce((a, f) => a + weights[f.severity], 0);
    const riskScore = total === 0 ? 0 : Math.min(100, Math.round(100 * (1 - Math.exp(-sum / 12))));

    const report: AuditReport = {
      id,
      sourceHash,
      source: input.source,
      filename: input.filename,
      address: input.address,
      chain: input.chain,
      createdAt: new Date().toISOString(),
      staticAnalysis: input.staticAnalysis,
      confirmedFindings: input.confirmedFindings,
      rejectedFindings: input.rejectedFindings,
      riskScore,
      summary: input.summary,
      notes: input.notes,
      model: input.model,
    };
    const path = this.pathFor(id);
    await writeFile(path, JSON.stringify(report, null, 2), 'utf8');
    return report;
  }

  async get(id: string): Promise<AuditReport | undefined> {
    const path = this.pathFor(id);
    if (!existsSync(path)) return undefined;
    const text = await readFile(path, 'utf8');
    return JSON.parse(text) as AuditReport;
  }

  async list(): Promise<{ id: string; createdAt: string; sourceHash: string; riskScore: number; summary: string }[]> {
    await this.ensureDir();
    const entries = await readdir(this.dir).catch(() => []);
    const out: { id: string; createdAt: string; sourceHash: string; riskScore: number; summary: string }[] = [];
    for (const e of entries) {
      if (!e.endsWith('.json')) continue;
      const id = e.slice(0, -'.json'.length);
      try {
        const r = await this.get(id);
        if (r) {
          out.push({
            id: r.id,
            createdAt: r.createdAt,
            sourceHash: r.sourceHash,
            riskScore: r.riskScore,
            summary: r.summary,
          });
        }
      } catch {
        // skip broken file
      }
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async delete(id: string): Promise<boolean> {
    const path = this.pathFor(id);
    if (!existsSync(path)) return false;
    await unlink(path);
    return true;
  }

  private pathFor(id: string): string {
    // Sanitise id: hex / dash only.
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new Error(`invalid audit id: ${id}`);
    }
    return join(this.dir, `${id}.json`);
  }

  async size(): Promise<number> {
    await this.ensureDir();
    try {
      const s = await stat(this.dir);
      return s.size;
    } catch {
      return 0;
    }
  }
}

let _default: AuditStore | undefined;
export function defaultAuditStore(): AuditStore {
  if (!_default) _default = new AuditStore();
  return _default;
}
export function _resetDefaultAuditStore(): void {
  _default = undefined;
}
