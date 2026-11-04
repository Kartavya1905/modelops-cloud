import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return <main className="flex min-h-dvh items-center px-4 py-12">{children}</main>;
}
