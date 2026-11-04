'use client';

import { ErrorState } from '@/components/common/states';

/** Keeps the org shell (sidebar, header) usable when one page fails. */
export default function OrgError({ error, reset }: { error: Error; reset: () => void }) {
  return <ErrorState error={error} onRetry={reset} />;
}
