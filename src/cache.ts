// src/cache.ts
// Content-hash-keyed cache for model responses. Used to make repeated runs
// reproducible and to skip redundant LLM calls when the same source has
// already been analyzed in this process.
//
// Design notes:
//   - Key: sha256(model + system + prompt + temperature + source). Small
//     probability of collision is acceptable; we use the full sha256
//     (64 hex chars) so collisions are astronomically rare.
//   - Value: any JSON-serialisable blob.
//   - Eviction: simple LRU. When full, drop oldest entry.
//   - Thread-safety: none needed — Node single-threaded. We do use a Map's
//     insertion order for LRU bookkeeping.

import { createHash } from 'node:crypto';

export interface CacheKeyParts {
  model: string;
  system?: string;
  prompt: string;
  temperature?: number;
  source?: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  const h = createHash('sha256');
  h.update('m=');
  h.update(parts.model);
  h.update('|s=');
  h.update(parts.system ?? '');
  h.update('|p=');
  h.update(parts.prompt);
  h.update('|t=');
  h.update(parts.temperature === undefined ? '' : String(parts.temperature));
  h.update('|src=');
  h.update(parts.source ?? '');
  return h.digest('hex');
}

/** Short, friendly id derived from a sha256 (first 12 hex chars). */
export function shortId(hash: string): string {
  return hash.slice(0, 12);
}

export interface CacheStats {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
}

export class ResponseCache<V = unknown> {
  private readonly cap: number;
  private readonly store = new Map<string, V>();
  private hits = 0;
  private misses = 0;

  constructor(capacity = 512) {
    this.cap = Math.max(1, capacity);
  }

  get(key: string): V | undefined {
    const v = this.store.get(key);
    if (v === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // Touch for LRU — re-insert to move to the back of the iteration order.
    this.store.delete(key);
    this.store.set(key, v);
    return v;
  }

  set(key: string, value: V): void {
    if (this.store.has(key)) this.store.delete(key);
    this.store.set(key, value);
    while (this.store.size > this.cap) {
      const first = this.store.keys().next().value;
      if (first === undefined) break;
      this.store.delete(first);
    }
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  delete(key: string): boolean {
    return this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats(): CacheStats {
    return {
      size: this.store.size,
      capacity: this.cap,
      hits: this.hits,
      misses: this.misses,
    };
  }
}

let _default: ResponseCache | undefined;

/** Process-wide default cache. Reset via {@link _resetDefaultCache} in tests. */
export function defaultCache(): ResponseCache {
  if (!_default) _default = new ResponseCache(512);
  return _default;
}

/** Test helper. */
export function _resetDefaultCache(): void {
  _default = undefined;
}
