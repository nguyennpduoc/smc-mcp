# Project Standards — smart-contract-mcp

This file is the single source of truth for stack conventions, build, test, and contribution rules. Follow it before making non-trivial changes.

## Project Snapshot
- **Purpose:** Model Context Protocol (stdio, TypeScript) server that gives any MCP client AI-powered smart-contract analysis, backed by the Cysic AI model (`minimax-m3`).
- **Innovations:** hybrid static+LLM pipeline, closed-loop self-audit, adversarial false-positive filter.
- **Stack:** Node ≥ 20, TypeScript 5.6, `@modelcontextprotocol/sdk` 1.0.4, axios 1.7, zod 3.23, `@solidity-parser/parser` 0.18, dotenv 16.4, vitest 2.1. ESM, `module/moduleResolution: Node16`.

## Build, Test, Run
- `npm run typecheck` — strict TS check, must exit 0 before merging.
- `npm run build` — emit `dist/` (`index.js`, `server.js`, sourcemaps, `.d.ts`). Must exit 0.
- `npm test` — full vitest suite, must exit 0.
- `npm run dev` — `tsx watch` for local iteration.
- `npm start` — runs the compiled stdio server (`node dist/index.js`). Requires `CYSIC_API_KEY`.

## Code Conventions
- ESM only (`"type": "module"`). All imports use the `.js` extension (Node16 resolution).
- Strict TS: no implicit `any`, no unused locals/params, exact-optional off (see `tsconfig.json`).
- Pure modules where possible; no global mutable state except the audit store and LRU cache (intentional).
- Never log the Cysic API key. The only place the raw key is constructed is the `Authorization: Bearer ${cfg.apiKey}` line in `src/cysicClient.ts`. The fingerprint helper in `src/config.ts` is the only place a derivative of the key appears in logs.

## Module Boundaries
- `src/cysicClient.ts` — exact Cysic reference call + timeout + retry/backoff + `CysicError` mapping. Do not add features here that belong in the reasoner.
- `src/llm/reasoner.ts` — owns prompt design (verdict + refuter) and the confidence floor.
- `src/llm/patcher.ts` — owns patch generation; always strip fences and pass through the response cache.
- `src/analysis/static.ts` — deterministic; the LLM never sees raw source alone, only structured findings.
- `src/tools/*` — thin MCP handlers. Business logic lives in `llm/` and `analysis/`.
- `src/audits/store.ts` and `src/cache.ts` — in-memory state. Documented as process-local.

## Testing
- Vitest, mocked axios (no live network in unit tests).
- New code must come with tests. The reviewer checks coverage of: static analyzer, cysic client, reasoner, patcher, diff util, audit store, resource read, prompts, source fetcher.
- The `CYSIC_API_KEY` literal is a fixture only; never assert against it in error messages.

## Documentation
- `README.md` — install, env, MCP-client registration JSON, example tool calls, FEATURE CHECKLIST.
- `docs/DESIGN.md` — three innovations + rationale.
- `docs/ARCHITECTURE.md` — module layout + data flow.
- `docs/AGENTS.md` — Planner → Builder → Reviewer workflow.

## Environment & Safety
- Fail-fast env: missing `CYSIC_API_KEY` exits 1 with a clean error. The key is never written to stdout.
- `.env` is gitignored; `.env.example` ships with safe defaults.
- Do not commit secrets. The CI/Reviewer greps for `sk-…` patterns and `CYSIC_API_KEY` literals.

## Workflow
- 3-role workflow only: PLANNER (this file + plan), BUILDER (implementation), REVIEWER (verification). No additional agents.
- One AC at a time. Each round must end with a `target_ac_status` of `done`, `pending`, or `blocked` and a concise summary.
