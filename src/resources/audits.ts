// src/resources/audits.ts
// Resource handler for `contract://audits/{id}` — returns the persisted
// JSON audit report for the given id. The full URI scheme is:
//   contract://audits              -> listing (JSON array of audit summaries)
//   contract://audits/{id}         -> a single audit report (JSON)

import { defaultAuditStore, type AuditStore, type AuditReport } from '../audits/store.js';

const URI_PREFIX = 'contract://audits/';

export interface ResourceListing {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export const auditsResourceDescriptor: ResourceListing = {
  uri: 'contract://audits',
  name: 'Stored smart-contract audit reports',
  description:
    'Audit reports persisted by audit_contract. Read `contract://audits` for an index, or `contract://audits/{id}` for a full report.',
  mimeType: 'application/json',
};

export interface ResourceReadResult {
  contents: { uri: string; mimeType: string; text: string }[];
}

export async function readAuditResource(
  uri: string,
  store: AuditStore = defaultAuditStore(),
): Promise<ResourceReadResult> {
  if (uri === 'contract://audits' || uri === 'contract://audits/') {
    const list = await store.list();
    return {
      contents: [
        {
          uri: 'contract://audits',
          mimeType: 'application/json',
          text: JSON.stringify(list, null, 2),
        },
      ],
    };
  }
  if (!uri.startsWith(URI_PREFIX)) {
    throw new Error(`unsupported resource URI: ${uri}`);
  }
  const id = uri.slice(URI_PREFIX.length);
  if (id.length === 0) {
    throw new Error(`audit id is required in ${uri}`);
  }
  const report = await store.get(id);
  if (!report) {
    throw new Error(`no audit report found for id "${id}"`);
  }
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(report, null, 2),
      },
    ],
  };
}

export function listAuditResourceTemplates(): { uriTemplate: string; name: string; description: string; mimeType: string }[] {
  return [
    {
      uriTemplate: 'contract://audits/{id}',
      name: 'Audit report by id',
      description: 'Fetch a single audit report previously saved by audit_contract.',
      mimeType: 'application/json',
    },
  ];
}

export type { AuditReport };
