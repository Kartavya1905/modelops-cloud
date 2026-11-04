import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginForm } from '@/features/auth/auth-forms';
import { safeNextPath } from '@/lib/auth/session';
import { json, mockFetch, ORG_ID, problem, renderWithClient, sessionAs } from './utils';

const router = { replace: vi.fn(), push: vi.fn() };
let search = '';
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useSearchParams: () => new URLSearchParams(search),
}));

beforeEach(() => {
  router.replace.mockReset();
  search = '';
});

async function fillAndSubmit(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  it('validates on the client before calling the API', async () => {
    const fetchSpy = mockFetch(() => json(200, {}));
    renderWithClient(<LoginForm />);
    await fillAndSubmit('not-an-email', '');
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the API’s message on 401 and stays on the page', async () => {
    mockFetch(() => problem(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.'));
    renderWithClient(<LoginForm />);
    await fillAndSubmit('ada@example.com', 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The email or password is incorrect.',
    );
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('explains rate limiting (429)', async () => {
    mockFetch(() => problem(429, 'RATE_LIMITED', 'Try again in 42 seconds.'));
    renderWithClient(<LoginForm />);
    await fillAndSubmit('ada@example.com', 'whatever-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in 42 seconds.',
    );
  });

  it('on success sends credentials to /api/v1/auth/login and goes to the first org', async () => {
    const fetchSpy = mockFetch(() => json(200, sessionAs('OWNER')));
    renderWithClient(<LoginForm />);
    await fillAndSubmit('ada@example.com', 'correct horse battery');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/orgs/${ORG_ID}/projects`));

    const req = fetchSpy.mock.calls[0]?.[0];
    expect(req?.method).toBe('POST');
    expect(new URL(req?.url ?? '').pathname).toBe('/api/v1/auth/login');
    expect(await req?.json()).toEqual({
      email: 'ada@example.com',
      password: 'correct horse battery',
    });
  });

  it('honours a safe ?next= and ignores an open-redirect attempt', async () => {
    mockFetch(() => json(200, sessionAs('OWNER')));
    search = 'next=//evil.example.com/phish';
    renderWithClient(<LoginForm />);
    await fillAndSubmit('ada@example.com', 'correct horse battery');
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith(`/orgs/${ORG_ID}/projects`));
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/orgs/1/projects', '/orgs/1/projects'],
    ['//evil.com', null],
    ['/\\evil.com', null],
    ['https://evil.com', null],
    ['', null],
    [null, null],
  ])('%s -> %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});
