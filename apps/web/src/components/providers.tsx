'use client';

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { toast, Toaster } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api/client';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        // Retry transient failures only; 4xx answers are final.
        retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      },
    },
    mutationCache: new MutationCache({
      // Every failed mutation shows a toast unless the component handles the error itself.
      onError: (err, _vars, _ctx, mutation) => {
        if (mutation.meta?.silentError !== true) toast.error(errorMessage(err));
      },
    }),
  });
}

declare module '@tanstack/react-query' {
  interface Register {
    mutationMeta: { silentError?: boolean };
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={client}>
      {children}
      {/* No richColors: its green-on-green success style fails WCAG AA contrast (found by axe in M3). */}
      {/* One toast at a time: stacked toasts are dimmed behind the newest, which fails contrast. */}
      <Toaster theme="system" closeButton visibleToasts={1} position="bottom-right" />
    </QueryClientProvider>
  );
}
