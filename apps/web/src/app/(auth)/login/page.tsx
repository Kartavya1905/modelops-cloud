import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from '@/features/auth/auth-forms';

export const metadata: Metadata = { title: 'Sign in' };

export default function LoginPage() {
  // useSearchParams (for ?next=) requires a Suspense boundary during static rendering.
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
