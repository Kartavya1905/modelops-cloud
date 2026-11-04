import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ProjectsPage } from '@/features/projects/projects-page';
import { json, mockFetch, ORG_ID, problem, renderWithClient, sessionAs } from './utils';

vi.mock('next/navigation', () => ({
  useParams: () => ({ orgId: ORG_ID }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const project = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${String(n)}`,
  orgId: ORG_ID,
  slug: `project-${String(n)}`,
  name: `Project ${String(n)}`,
  description: null,
  createdById: 'u-1',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  archivedAt: null,
});

describe('ProjectsPage', () => {
  it('shows an empty state, and hides "New project" from Viewers', async () => {
    mockFetch(() => json(200, { data: [], nextCursor: null }));
    renderWithClient(<ProjectsPage />, { session: sessionAs('VIEWER') });
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new project/i })).not.toBeInTheDocument();
  });

  it('lists projects with links to their detail pages', async () => {
    mockFetch(() => json(200, { data: [project(1), project(2)], nextCursor: null }));
    renderWithClient(<ProjectsPage />, { session: sessionAs('VIEWER') });
    const link = await screen.findByRole('link', { name: 'Project 1' });
    expect(link).toHaveAttribute('href', `/orgs/${ORG_ID}/projects/${project(1).id}`);
    expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2
  });

  it('shows an error state with retry when the API fails', async () => {
    mockFetch(() => new Response('upstream down', { status: 502 }));
    renderWithClient(<ProjectsPage />, { session: sessionAs('OWNER') });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The API is not reachable right now.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('creates a project with the CSRF header, and shows a slug conflict next to the name field', async () => {
    let created = false;
    const fetchSpy = mockFetch((req) => {
      if (req.method === 'POST') {
        if (!created) {
          created = true;
          return problem(
            409,
            'PROJECT_SLUG_TAKEN',
            'A project with the URL name "churn" already exists.',
          );
        }
        return json(201, project(3));
      }
      return json(200, { data: created ? [project(3)] : [], nextCursor: null });
    });

    // The CSRF token is set by the session fetch in real use; set it directly here.
    const { setCsrfToken } = await import('@/lib/api/client');
    setCsrfToken('csrf-test-token');

    renderWithClient(<ProjectsPage />, { session: sessionAs('ML_ENGINEER') });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /new project/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Churn');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));

    expect(await within(dialog).findByText(/already exists/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');

    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    const post = fetchSpy.mock.calls.map((c) => c[0]).find((r) => r.method === 'POST');
    expect(post?.headers.get('x-csrf-token')).toBe('csrf-test-token');
  });
});
