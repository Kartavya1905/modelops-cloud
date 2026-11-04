'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ErrorState } from '@/components/common/states';
import { Skeleton } from '@/components/ui/primitives';
import { useSession } from '@/lib/auth/session';

/** "/" sends signed-in users to their first organization and everyone else to sign-in. */
export default function HomePage() {
  const router = useRouter();
  const session = useSession();
  const target = session.data
    ? `/orgs/${session.data.memberships[0]?.orgId ?? ''}/projects`
    : session.data === null
      ? '/login'
      : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [router, target]);

  if (session.isError) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
      <Skeleton className="h-8 w-48" />
    </div>
  );
}
