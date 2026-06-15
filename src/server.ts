// src/server.ts
// MCP server wiring. Connects the tool/resource/prompt registries to the
// @modelcontextprotocol/sdk Server class over the stdio transport.
//
// Lifecycle:
//   start() reads env via loadConfig() and validates CYSIC_API_KEY,
//   instantiates the CysicClient, constructs the MCP Server, registers
//   request handlers, attaches a StdioServerTransport, and runs.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerResult,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig, describeConfig } from './config.js';
import { ALL_TOOLS, getTool } from './tools/index.js';
import { readAuditResource, auditsResourceDescriptor, listAuditResourceTemplates } from './resources/audits.js';
import {
  ALL_PROMPTS,
  renderSecurityAudit,
  renderGasReview,
  type PromptDescriptor,
} from './prompts/index.js';
import { CysicError } from './cysicClient.js';

export interface BuildServerOptions {
  /** Override the server name (used in `serverInfo`). */
  name?: string;
  /** Override the server version. */
  version?: string;
}

const DEFAULT_NAME = 'smart-contract-mcp';
const DEFAULT_VERSION = '0.1.0';

export function buildServer(opts: BuildServerOptions = {}): Server {
  const server = new Server(
    { name: opts.name ?? DEFAULT_NAME, version: opts.version ?? DEFAULT_VERSION },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  // -------------------------------------------------------------------- //
  //                              Tools                                   //
  // -------------------------------------------------------------------- //
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS.map((t) => ({
        name: t.descriptor.name,
        description: t.descriptor.description,
        inputSchema: t.descriptor.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = getTool(name);
    if (!entry) {
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `unknown tool: ${name}` }],
      };
    }
    try {
      const result = await entry.handler(args ?? {});
      if ('isError' in result) {
        return { isError: true, content: result.content };
      }
      return { content: result.content };
    } catch (err) {
      // Defensive — handlers should already convert errors to ToolErrorResult.
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `${name} failed: ${message}` }],
      };
    }
  });

  // -------------------------------------------------------------------- //
  //                            Resources                                 //
  // -------------------------------------------------------------------- //
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: auditsResourceDescriptor.uri,
          name: auditsResourceDescriptor.name,
          description: auditsResourceDescriptor.description,
          mimeType: auditsResourceDescriptor.mimeType,
        },
      ],
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: listAuditResourceTemplates().map((t) => ({
        uriTemplate: t.uriTemplate,
        name: t.name,
        description: t.description,
        mimeType: t.mimeType,
      })),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    try {
      const result = await readAuditResource(uri);
      return result as unknown as ServerResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        contents: [
          {
            uri,
            mimeType: 'text/plain',
            text: `error: ${message}`,
          },
        ],
      } as unknown as ServerResult;
    }
  });

  // -------------------------------------------------------------------- //
  //                             Prompts                                  //
  // -------------------------------------------------------------------- //
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: ALL_PROMPTS.map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments,
      })),
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const prompt: PromptDescriptor | undefined = ALL_PROMPTS.find((p) => p.name === name);
    if (!prompt) {
      throw new Error(`unknown prompt: ${name}`);
    }
    if (name === 'security_audit') {
      return renderSecurityAudit(args ?? {}) as unknown as ServerResult;
    }
    if (name === 'gas_review') {
      return renderGasReview(args ?? {}) as unknown as ServerResult;
    }
    throw new Error(`prompt not implemented: ${name}`);
  });

  // -------------------------------------------------------------------- //
  //                          Error reporting                             //
  // -------------------------------------------------------------------- //
  server.onerror = (err) => {
    // Never log the API key. The CysicError class already sanitizes.
    const safe = err instanceof CysicError
      ? { code: err.code, message: err.message, status: err.status }
      : { message: err instanceof Error ? err.message : String(err) };
    // eslint-disable-next-line no-console
    console.error('[smart-contract-mcp] server error', safe);
  };

  return server;
}

export interface StartOptions extends BuildServerOptions {
  /** Inject a transport (default: StdioServerTransport on process stdio). */
  transport?: StdioServerTransport;
}

/**
 * Validate config, build the server, attach a transport, and run.
 * Throws if CYSIC_API_KEY is missing.
 */
export async function start(opts: StartOptions = {}): Promise<Server> {
  const cfg = loadConfig();
  // eslint-disable-next-line no-console
  console.error('[smart-contract-mcp] starting', describeConfig(cfg));
  const server = buildServer(opts);
  const transport = opts.transport ?? new StdioServerTransport();
  await server.connect(transport);
  return server;
}
