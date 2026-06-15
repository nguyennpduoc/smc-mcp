// src/tools/index.ts
// Registry that lists every tool the MCP server exposes. Adding a new tool
// means: (1) implement the handler + descriptor, (2) add it to this list.

import { auditContractTool, handleAuditContract } from './audit_contract.js';
import { explainContractTool, handleExplainContract } from './explain_contract.js';
import { suggestFixTool, handleSuggestFix } from './suggest_fix.js';
import { generateContractTool, handleGenerateContract } from './generate_contract.js';
import type { ToolDescriptor, ToolHandlerResult } from './types.js';

export interface ToolEntry {
  descriptor: ToolDescriptor;
  /** Pure handler — does not throw on validation, returns ToolErrorResult instead. */
  handler: (input: unknown) => Promise<ToolHandlerResult>;
}

export const ALL_TOOLS: ToolEntry[] = [
  {
    descriptor: auditContractTool,
    handler: (input) => handleAuditContract(input),
  },
  {
    descriptor: explainContractTool,
    handler: (input) => handleExplainContract(input),
  },
  {
    descriptor: suggestFixTool,
    handler: (input) => handleSuggestFix(input),
  },
  {
    descriptor: generateContractTool,
    handler: (input) => handleGenerateContract(input),
  },
];

export function getTool(name: string): ToolEntry | undefined {
  return ALL_TOOLS.find((t) => t.descriptor.name === name);
}
