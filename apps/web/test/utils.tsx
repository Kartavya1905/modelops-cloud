import type { Permission, Role, Session } from '@modelops/api-contract';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import { qk } from '@/lib/query/keys';

export const ORG_ID = '7f1d2c3b-0000-4000-8000-000000000001';

// Mirrors apps/api/src/common/authz/permissions.ts (the API's /auth/me sends the same lists).
const READ: Permission[] = [
  'org:read',
  'member:read',
  'project:read',
  'experiment:read',
  'model:read',
  'approval:read',
];
const WRITE: Permission[] = [
  ...READ,
  'project:create',
  'project:update',
  'model:create',
  'model:register',
  'release:manage',
];
const ADMIN: Permission[] = [
  ...WRITE,
  'member:manage',
  'invitation:create',
  'project:archive',
  'audit:read',
  'approval:decide',
];
const PERMS: Record<Role, Permission[]> = {
  OWNER: ADMIN,
  ADMIN,
  ML_ENGINEER: WRITE,
  VIEWER: READ,
};

export function sessionAs(role: Role): Session {
  return {
    user: { id: 'u-1', email: 'ada@example.com', name: 'Ada' },
    memberships: [
      { orgId: ORG_ID, orgName: 'Acme', orgSlug: 'acme', role, permissions: PERMS[role] },
    ],
    csrfToken: 'csrf-test-token',
  };
}

export function renderWithClient(ui: ReactElement, opts: { session?: Session | null } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (opts.session !== undefined) client.setQueryData(qk.session, opts.session);
  return { client, ...render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>) };
}

type Handler = (req: Request) => Response | Promise<Response>;

/** Replaces global fetch; returns a spy whose calls are the Request objects sent. */
export function mockFetch(handler: Handler) {
  const spy = vi.fn((input: Request) => Promise.resolve(handler(input)));
  vi.stubGlobal('fetch', spy);
  return spy;
}

export const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

export const problem = (status: number, code: string, detail: string, extra: object = {}) =>
  json(
    status,
    { type: 'about:blank', title: code, status, code, detail, ...extra },
    'application/problem+json',
  );
