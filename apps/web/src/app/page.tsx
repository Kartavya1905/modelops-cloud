import { PlatformStatus } from '@/components/platform-status';

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12 sm:px-6">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium tracking-wide text-indigo-600 uppercase dark:text-indigo-400">
          Milestone 1 · local environment
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">ModelOps Cloud</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          Self-service platform to train, register, validate, deploy and monitor machine-learning
          models. This page confirms the web app can reach the control-plane API through the{' '}
          <code className="font-mono text-sm">/api</code> rewrite.
        </p>
      </header>
      <PlatformStatus />
    </main>
  );
}
