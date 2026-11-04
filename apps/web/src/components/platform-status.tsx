'use client';

import { useEffect, useState } from 'react';
import { toPlatformState, type PlatformState } from '@/lib/health';

const POLL_MS = 5000;

async function fetchState(signal: AbortSignal): Promise<PlatformState> {
  try {
    const res = await fetch('/api/v1/health/ready', { cache: 'no-store', signal });
    const body: unknown = await res.json().catch(() => null);
    return toPlatformState(res.status, body);
  } catch (err) {
    if (signal.aborted) throw err;
    return { kind: 'unreachable', message: 'Network error while contacting the API.' };
  }
}

/** Polls the API readiness endpoint and shows each dependency's status. */
export function PlatformStatus() {
  const [state, setState] = useState<PlatformState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        setState(await fetchState(controller.signal));
        timer = setTimeout(() => void tick(), POLL_MS);
      } catch {
        // aborted on unmount
      }
    };
    void tick();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);

  return (
    <section
      aria-labelledby="status-heading"
      className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="flex items-center justify-between gap-4">
        <h2 id="status-heading" className="text-lg font-semibold">
          Platform status
        </h2>
        <OverallBadge state={state} />
      </div>

      <div aria-live="polite" className="mt-4">
        {state.kind === 'loading' && <p className="text-zinc-500">Checking services…</p>}
        {state.kind === 'unreachable' && (
          <p className="text-red-700 dark:text-red-400">{state.message}</p>
        )}
        {(state.kind === 'ready' || state.kind === 'degraded') && (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {Object.entries(state.report.checks).map(([name, check]) => (
              <li key={name} className="flex items-center justify-between gap-4 py-3">
                <span className="font-mono text-sm">{name}</span>
                <span className="flex items-center gap-3 text-sm">
                  {check.error && (
                    <span className="text-zinc-500" title={check.error}>
                      {check.error.length > 40 ? `${check.error.slice(0, 40)}…` : check.error}
                    </span>
                  )}
                  <span className="tabular-nums text-zinc-500">{check.latencyMs} ms</span>
                  <span
                    className={
                      check.status === 'up'
                        ? 'rounded-full bg-emerald-100 px-2 py-0.5 font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'rounded-full bg-red-100 px-2 py-0.5 font-medium text-red-800 dark:bg-red-950 dark:text-red-300'
                    }
                  >
                    {check.status === 'up' ? '● Up' : '✕ Down'}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function OverallBadge({ state }: { state: PlatformState }) {
  const map = {
    loading: ['Checking', 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'],
    ready: [
      'All systems ready',
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    ],
    degraded: ['Degraded', 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300'],
    unreachable: ['API unreachable', 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'],
  } as const;
  const [label, classes] = map[state.kind];
  return <span className={`rounded-full px-3 py-1 text-sm font-medium ${classes}`}>{label}</span>;
}
