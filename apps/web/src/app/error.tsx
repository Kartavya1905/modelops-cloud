'use client';

import { ErrorState } from '@/components/common/states';

/** Last-resort error boundary for anything that throws while rendering. */
export default function RootError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md px-4 py-24">
      <ErrorState error={error} onRetry={reset} />
    </main>
  );
}
