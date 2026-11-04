'use client';

import type { Session } from '@modelops/api-contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BoxesIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { type SubmitEvent, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import { Alert, Card, CardContent, Field, Input } from '@/components/ui/primitives';
import { api, ApiError, setCsrfToken, unwrap } from '@/lib/api/client';
import { safeNextPath } from '@/lib/auth/session';
import { qk } from '@/lib/query/keys';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const noop = () => () => undefined;
/**
 * False during server render and until React hydrates. Submit buttons stay disabled until then:
 * otherwise an early click would make the browser submit the form natively, skipping validation
 * and the API call.
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
}

/** After sign-in: go where the user was heading, else to their first organization. */
function useOnSignedIn() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const next = safeNextPath(useSearchParams().get('next'));
  return (session: Session) => {
    setCsrfToken(session.csrfToken);
    queryClient.clear();
    queryClient.setQueryData(qk.session, session);
    const first = session.memberships[0];
    router.replace(next ?? (first ? `/orgs/${first.orgId}/projects` : '/'));
  };
}

function AuthCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-6">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="rounded-lg bg-primary p-2 text-primary-foreground">
          <BoxesIcon className="size-6" aria-hidden />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <Card>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

export function LoginForm() {
  const hydrated = useHydrated();
  const onSignedIn = useOnSignedIn();
  // Keep ?next= when switching to sign-up, so an invite link survives "create an account first".
  const nextParam = safeNextPath(useSearchParams().get('next'));
  const registerHref = nextParam ? `/register?next=${encodeURIComponent(nextParam)}` : '/register';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const login = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/auth/login', { body: { email, password } })),
    meta: { silentError: true },
    onSuccess: onSignedIn,
  });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!EMAIL.test(email.trim())) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    if (Object.keys(next).length === 0) login.mutate();
  }

  const apiError = login.error instanceof ApiError ? login.error : null;
  return (
    <AuthCard title="Sign in to ModelOps Cloud" subtitle="Deploy and monitor your models.">
      <form method="post" className="grid gap-4" onSubmit={submit} noValidate>
        {apiError && (
          <Alert variant="destructive">
            {apiError.problem.code === 'RATE_LIMITED'
              ? `Too many attempts. ${apiError.problem.detail ?? ''}`
              : (apiError.problem.detail ?? apiError.problem.title)}
          </Alert>
        )}
        <Field id="email" label="Email" error={errors.email}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? 'email-error' : undefined}
          />
        </Field>
        <Field id="password" label="Password" error={errors.password}>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password}
            aria-describedby={errors.password ? 'password-error' : undefined}
          />
        </Field>
        <Button type="submit" disabled={!hydrated || login.isPending}>
          {login.isPending ? 'Signing in…' : 'Sign in'}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          No account?{' '}
          <Link
            className="font-medium text-primary underline-offset-4 hover:underline"
            href={registerHref}
          >
            Create one
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}

export function RegisterForm() {
  const hydrated = useHydrated();
  const onSignedIn = useOnSignedIn();
  const nextParam = useSearchParams().get('next');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const register = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/auth/register', { body: { name, email, password } })),
    meta: { silentError: true },
    onSuccess: onSignedIn,
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors());
    },
  });

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter your name.';
    if (!EMAIL.test(email.trim())) next.email = 'Enter a valid email address.';
    if (password.length < 12) next.password = 'Use at least 12 characters.';
    setErrors(next);
    if (Object.keys(next).length === 0) register.mutate();
  }

  const apiError = register.error instanceof ApiError ? register.error : null;
  const loginHref = nextParam ? `/login?next=${encodeURIComponent(nextParam)}` : '/login';
  return (
    <AuthCard title="Create your account" subtitle="You get a personal workspace to start in.">
      <form method="post" className="grid gap-4" onSubmit={submit} noValidate>
        {apiError && apiError.problem.code !== 'VALIDATION_FAILED' && (
          <Alert variant="destructive">{apiError.problem.detail ?? apiError.problem.title}</Alert>
        )}
        <Field id="name" label="Name" error={errors.name}>
          <Input
            id="name"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!!errors.name}
          />
        </Field>
        <Field id="email" label="Email" error={errors.email}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email}
          />
        </Field>
        <Field
          id="password"
          label="Password"
          error={errors.password}
          hint="At least 12 characters."
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password}
          />
        </Field>
        <Button type="submit" disabled={!hydrated || register.isPending}>
          {register.isPending ? 'Creating account…' : 'Create account'}
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link
            className="font-medium text-primary underline-offset-4 hover:underline"
            href={loginHref}
          >
            Sign in
          </Link>
        </p>
      </form>
    </AuthCard>
  );
}
