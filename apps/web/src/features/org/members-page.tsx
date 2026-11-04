'use client';

import type { CreatedInvitation, Member, Role } from '@modelops/api-contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon, CopyIcon, MailPlusIcon, UserMinusIcon } from 'lucide-react';
import { type SubmitEvent, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import {
  ErrorState,
  PageHeader,
  PermissionGate,
  RoleBadge,
  roleLabel,
  TableSkeleton,
} from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
} from '@/components/ui/primitives';
import { NativeSelect } from '@/components/ui/select';
import { useOrgId } from '@/features/org/org-shell';
import { api, ApiError, unwrap } from '@/lib/api/client';
import { useCan, useMembership, useSession } from '@/lib/auth/session';
import { qk } from '@/lib/query/keys';
import { formatDateTime, formatRelative } from '@/lib/utils';

const ROLES: Role[] = ['OWNER', 'ADMIN', 'ML_ENGINEER', 'VIEWER'];

function InviteDialog({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const myRole = useMembership(orgId)?.role;
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('ML_ENGINEER');
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [copied, setCopied] = useState(false);

  const invite = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/orgs/{orgId}/invitations', {
          params: { path: { orgId } },
          body: { email, role },
        }),
      ),
    meta: { silentError: true },
    onSuccess: async (inv) => {
      setCreated(inv);
      await queryClient.invalidateQueries({ queryKey: qk.invitations(orgId) });
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not create invitation.'),
  });

  const link = created ? `${window.location.origin}${created.acceptPath}` : '';

  function reset(next: boolean) {
    setOpen(next);
    if (!next) {
      setEmail('');
      setError(undefined);
      setCreated(null);
      setCopied(false);
    }
  }

  function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Enter a valid email address.');
      return;
    }
    setError(undefined);
    invite.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={reset}>
      <DialogTrigger asChild>
        <Button>
          <MailPlusIcon aria-hidden />
          Invite member
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>Invitation created</DialogTitle>
              <DialogDescription>
                Send this link to {created.email}. It works once, only for that email address, and
                expires {formatDateTime(created.expiresAt)}. It is shown only now.
              </DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input
                readOnly
                value={link}
                aria-label="Invitation link"
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="outline"
                size="icon"
                aria-label="Copy link"
                onClick={() => {
                  void navigator.clipboard.writeText(link).then(() => setCopied(true));
                }}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => reset(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="grid gap-4" onSubmit={submit} noValidate>
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>
                You get a one-time link to share. ModelOps Cloud does not send email (zero-cost
                setup).
              </DialogDescription>
            </DialogHeader>
            <Field id="invite-email" label="Email" error={error}>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                aria-invalid={!!error}
              />
            </Field>
            <Field id="invite-role" label="Role">
              <NativeSelect
                id="invite-role"
                value={role}
                onChange={(e) => setRole(e.target.value as Role)}
              >
                {ROLES.filter((r) => r !== 'OWNER' || myRole === 'OWNER').map((r) => (
                  <option key={r} value={r}>
                    {roleLabel(r)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? 'Creating…' : 'Create invitation link'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PendingInvitations({ orgId }: { orgId: string }) {
  const query = useQuery({
    queryKey: qk.invitations(orgId),
    queryFn: () =>
      unwrap(api.GET('/api/v1/orgs/{orgId}/invitations', { params: { path: { orgId } } })),
  });
  if (!query.data || query.data.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Pending invitations</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-2 text-sm">
          {query.data.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2">
              <span>{inv.email}</span>
              <span className="flex items-center gap-2 text-muted-foreground">
                <RoleBadge role={inv.role} /> expires {formatRelative(inv.expiresAt)}
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export function MembersPage() {
  const orgId = useOrgId();
  const queryClient = useQueryClient();
  const me = useSession().data?.user;
  const myRole = useMembership(orgId)?.role;
  const canManage = useCan(orgId, 'member:manage');
  const [removing, setRemoving] = useState<Member | null>(null);

  const query = useQuery({
    queryKey: qk.members(orgId),
    queryFn: () => unwrap(api.GET('/api/v1/orgs/{orgId}/members', { params: { path: { orgId } } })),
  });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      unwrap(
        api.PATCH('/api/v1/orgs/{orgId}/members/{userId}', {
          params: { path: { orgId, userId } },
          body: { role },
        }),
      ),
    onSuccess: async (m) => {
      toast.success(`${m.name} is now ${roleLabel(m.role)}`);
      await queryClient.invalidateQueries({ queryKey: qk.members(orgId) });
      await queryClient.invalidateQueries({ queryKey: qk.session });
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      unwrap(
        api.DELETE('/api/v1/orgs/{orgId}/members/{userId}', {
          params: { path: { orgId, userId } },
        }),
      ),
    onSuccess: async () => {
      toast.success('Member removed');
      setRemoving(null);
      await queryClient.invalidateQueries({ queryKey: qk.members(orgId) });
    },
  });

  /** Mirrors the API's owner rules so the UI doesn't offer actions that would be refused. */
  const editable = (m: Member) => canManage && (m.role !== 'OWNER' || myRole === 'OWNER');

  return (
    <div className="grid gap-6">
      <PageHeader
        title="Members"
        description="Roles decide what each person can do in this organization."
        actions={
          <PermissionGate orgId={orgId} permission="invitation:create">
            <InviteDialog orgId={orgId} />
          </PermissionGate>
        }
      />
      {query.isPending ? (
        <TableSkeleton />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className="rounded-xl border bg-card">
          <Table>
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th className="hidden sm:table-cell">Joined</Th>
                <Th>Role</Th>
                {canManage && (
                  <Th className="w-12">
                    <span className="sr-only">Actions</span>
                  </Th>
                )}
              </Tr>
            </THead>
            <TBody>
              {query.data.map((m) => (
                <Tr key={m.userId}>
                  <Td>
                    <div className="font-medium">
                      {m.name}{' '}
                      {m.userId === me?.id && <span className="text-muted-foreground">(you)</span>}
                    </div>
                    <div className="text-xs text-muted-foreground">{m.email}</div>
                  </Td>
                  <Td className="hidden text-muted-foreground sm:table-cell">
                    {formatRelative(m.joinedAt)}
                  </Td>
                  <Td>
                    {editable(m) ? (
                      <NativeSelect
                        aria-label={`Role for ${m.name}`}
                        value={m.role}
                        disabled={changeRole.isPending}
                        onChange={(e) =>
                          changeRole.mutate({ userId: m.userId, role: e.target.value as Role })
                        }
                      >
                        {ROLES.filter((r) => r !== 'OWNER' || myRole === 'OWNER').map((r) => (
                          <option key={r} value={r}>
                            {roleLabel(r)}
                          </option>
                        ))}
                      </NativeSelect>
                    ) : (
                      <RoleBadge role={m.role} />
                    )}
                  </Td>
                  {canManage && (
                    <Td>
                      {editable(m) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${m.name}`}
                          onClick={() => setRemoving(m)}
                        >
                          <UserMinusIcon />
                        </Button>
                      )}
                    </Td>
                  )}
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}
      <PermissionGate orgId={orgId} permission="member:manage">
        <PendingInvitations orgId={orgId} />
      </PermissionGate>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        description="They lose access to this organization immediately. You can invite them again later."
        confirmLabel="Remove member"
        pending={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.userId)}
      />
    </div>
  );
}
