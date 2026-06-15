// src/prompts/index.ts
// Reusable prompt templates the MCP server exposes. Two prompts:
//   - security_audit: drives audit_contract end-to-end
//   - gas_review: focused on gas optimization rather than security

import { z } from 'zod';

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptDescriptor {
  name: string;
  description: string;
  arguments: PromptArgument[];
}

export interface PromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description: string;
  messages: PromptMessage[];
}

export const securityAuditPrompt: PromptDescriptor = {
  name: 'security_audit',
  description:
    'Run a security audit on a Solidity contract. Asks the model to invoke audit_contract and surface the top issues to the user.',
  arguments: [
    {
      name: 'source',
      description: 'Full Solidity source code of the contract to audit.',
      required: true,
    },
    {
      name: 'filename',
      description: 'Optional filename label used in evidence lines.',
      required: false,
    },
  ],
};

export const gasReviewPrompt: PromptDescriptor = {
  name: 'gas_review',
  description:
    'Run a gas-efficiency review on a Solidity contract. Calls explain_contract and asks the model to enumerate optimisation opportunities (storage packing, calldata, caching, custom errors, unchecked loops, etc.).',
  arguments: [
    {
      name: 'source',
      description: 'Full Solidity source code of the contract to review.',
      required: true,
    },
    {
      name: 'filename',
      description: 'Optional filename label.',
      required: false,
    },
  ],
};

const SecurityAuditArgs = z.object({
  source: z.string().min(1),
  filename: z.string().optional(),
});

const GasReviewArgs = z.object({
  source: z.string().min(1),
  filename: z.string().optional(),
});

export function renderSecurityAudit(args: Record<string, unknown>): PromptResult {
  const { source, filename } = SecurityAuditArgs.parse(args);
  const label = filename ? ` (${filename})` : '';
  return {
    description: `Security audit of a Solidity contract${label}.`,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Audit the following Solidity contract${label}:`,
            '',
            '1. Call the audit_contract tool with the source. Read the full result.',
            '2. For each finding of severity "critical" or "high", explain it in plain English to me.',
            '3. For the top 3 findings, call suggest_fix with the finding id and show me the patched source and the before/after risk score.',
            '4. Summarise the overall risk posture and the order in which I should ship fixes.',
            '',
            '```solidity',
            source,
            '```',
          ].join('\n'),
        },
      },
    ],
  };
}

export function renderGasReview(args: Record<string, unknown>): PromptResult {
  const { source, filename } = GasReviewArgs.parse(args);
  const label = filename ? ` (${filename})` : '';
  return {
    description: `Gas review of a Solidity contract${label}.`,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: [
            `Review the following Solidity contract${label} for gas-efficiency.`,
            '',
            '1. Call explain_contract to get a structured summary of public surface and state.',
            '2. For each function, identify gas optimisations across: storage packing, calldata vs memory, caching SLOADs, using `unchecked` where overflow is impossible, replacing `require` strings with custom errors, batching events, removing redundant zero-init, using `internal` over `public` where the function is not called externally.',
            '3. Where the static analyzer flagged a pattern, also note any security implications of the gas fix you are proposing.',
            '4. Return a ranked list of the top 5 changes with the estimated gas delta and the relevant line numbers.',
            '',
            '```solidity',
            source,
            '```',
          ].join('\n'),
        },
      },
    ],
  };
}

export const ALL_PROMPTS: PromptDescriptor[] = [securityAuditPrompt, gasReviewPrompt];
