#!/usr/bin/env node
// src/index.ts
// Entry point. Loads .env via the side-effect import in config.ts and
// starts the MCP server over stdio. All errors caught at the top level
// are written to stderr (NOT stdout, which is the JSON-RPC channel).

import { start } from './server.js';

start().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`[smart-contract-mcp] fatal: ${message}`);
  process.exit(1);
});
