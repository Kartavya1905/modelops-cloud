'use client';

import type { Permission, Session } from '@modelops/api-contract';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError, setCsrfToken, unwrap } from '@/lib/api/client';
import { qk } from '@/lib/query/keys';

export async function fetchSession(): Promise<Session | null> {
  try {
    const s = await unwrap(api.GET('/api/v1/auth/me'));
    setCsrfToken(s.csrfToken);
    return s;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCsrfToken(null);
      return null;
    }
    throw err;
  }
}

/** The signed-in user (null when signed out). Cached for the whole app. */
export function useSession() {
  return useQuery({ queryKey: qk.session, queryFn: fetchSession, staleTime: 60_000, retry: false });
}

export function useMembership(orgId: string) {
  const { data } = useSession();
  return data?.memberships.find((m) => m.orgId === orgId);
}

/**
 * UI hint only: hides controls the user cannot use. The API enforces every permission
 * independently, so a tampered client gains nothing (docs/02, section 7).
 */
export function useCan(orgId: string, permission: Permission): boolean {
  return useMembership(orgId)?.permissions.includes(permission) ?? false;
}

/** Only same-site relative paths are allowed as post-login destinations (no open redirect). */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\'))
    return null;
  return next;
}
