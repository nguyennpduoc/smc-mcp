// src/tools/types.ts
// Shared types and helpers for MCP tool handlers. The MCP SDK 1.0
// lower-level Server expects each tool to be wired up via
// `server.setRequestHandler(ListToolsRequestSchema, ...)` and
// `server.setRequestHandler(CallToolRequestSchema, ...)`.

import type { z } from 'zod';

export interface ToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema describing the tool's input parameters. */
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolErrorResult {
  isError: true;
  content: TextContent[];
}

export interface ToolSuccessResult {
  content: TextContent[];
}

export type ToolHandlerResult = ToolSuccessResult | ToolErrorResult;

/** Wraps structured data as a single text content JSON string. */
export function jsonText(data: unknown): TextContent {
  return { type: 'text', text: JSON.stringify(data, null, 2) };
}

/** Wraps a single markdown / text block. */
export function textBlock(text: string): TextContent {
  return { type: 'text', text };
}

export function errorResult(message: string, details?: unknown): ToolErrorResult {
  const text =
    details === undefined
      ? message
      : `${message}\n\nDetails:\n\`\`\`json\n${JSON.stringify(details, null, 2)}\n\`\`\``;
  return { isError: true, content: [{ type: 'text', text }] };
}

export function okResult(data: unknown): ToolSuccessResult {
  return { content: [jsonText(data)] };
}

/** Type-safe zod input validator helper. */
export function validateInput<S extends z.ZodTypeAny>(
  schema: S,
  raw: unknown,
  toolName: string,
): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ToolInputError(`${toolName}: invalid input:\n${issues}`);
  }
  return parsed.data as z.output<S>;
}

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}
