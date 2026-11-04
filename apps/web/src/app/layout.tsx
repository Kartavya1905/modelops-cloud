import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ModelOps Cloud', template: '%s · ModelOps Cloud' },
  description: 'Train, register, validate, deploy and monitor ML models.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
