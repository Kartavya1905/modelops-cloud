import type { Metadata } from 'next';
import { PlatformStatus } from '@/components/platform-status';

export const metadata: Metadata = { title: 'Platform status' };

/** Public page from Milestone 1: proves the web app reaches the API through the /api rewrite. */
export default function StatusPage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">ModelOps Cloud status</h1>
        <p className="text-muted-foreground">
          Live readiness of the control-plane API and its dependencies.
        </p>
      </header>
      <PlatformStatus />
    </main>
  );
}
