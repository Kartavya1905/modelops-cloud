import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PermissionGate } from '@/components/common/states';
import { ORG_ID, renderWithClient, sessionAs } from './utils';

describe('PermissionGate', () => {
  it('renders children when the role grants the permission', () => {
    renderWithClient(
      <PermissionGate orgId={ORG_ID} permission="project:create">
        <button>New project</button>
      </PermissionGate>,
      { session: sessionAs('ML_ENGINEER') },
    );
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
  });

  it('renders the fallback (nothing by default) for a role without it', () => {
    renderWithClient(
      <PermissionGate orgId={ORG_ID} permission="project:create" fallback={<p>Read-only</p>}>
        <button>New project</button>
      </PermissionGate>,
      { session: sessionAs('VIEWER') },
    );
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('renders nothing for an organization the user does not belong to', () => {
    renderWithClient(
      <PermissionGate orgId="another-org" permission="project:read">
        <p>secret</p>
      </PermissionGate>,
      { session: sessionAs('OWNER') },
    );
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
});
