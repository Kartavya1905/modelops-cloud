import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RegisterForm } from '@/features/auth/auth-forms';

export const metadata: Metadata = { title: 'Create account' };

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}
