'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ErrorState, RoleBadge } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  Alert,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Skeleton,
} from '@/components/ui/primitives';
import { api, ApiError, unwrap } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { qk } from '@/lib/query/keys';

export function AcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();

  const preview = useQuery({
    queryKey: qk.invitation(token),
    queryFn: () => unwrap(api.GET('/api/v1/invitations/{token}', { params: { path: { token } } })),
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () =>
      unwrap(api.POST('/api/v1/invitations/{token}/accept', { params: { path: { token } } })),
    meta: { silentError: true },
    onSuccess: async ({ orgId }) => {
      await queryClient.invalidateQueries({ queryKey: qk.session });
      router.replace(`/orgs/${orgId}/projects`);
    },
  });

  return (
    <div className="mx-auto w-full max-w-md px-4 py-16">
      {preview.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : preview.isError ? (
        preview.error instanceof ApiError && preview.error.status === 404 ? (
          <Card>
            <CardHeader>
              <CardTitle>Invitation not available</CardTitle>
              <CardDescription>
                This link was already used, has expired, or is not valid. Ask for a new invitation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link href="/">Go to ModelOps Cloud</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        )
      ) : (
        <Card>
          <CardHeader>
            <MailCheckIcon className="size-6 text-primary" aria-hidden />
            <CardTitle>Join {preview.data.orgName}</CardTitle>
            <CardDescription>
              You were invited as <RoleBadge role={preview.data.role} /> ({preview.data.email}).
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {session.data && session.data.user.email !== preview.data.email && (
              <Alert variant="destructive">
                You are signed in as {session.data.user.email}. Sign in as {preview.data.email} to
                accept.
              </Alert>
            )}
            {accept.error && (
              <Alert variant="destructive">
                {accept.error instanceof ApiError
                  ? accept.error.message
                  : 'Could not accept the invitation.'}
              </Alert>
            )}
            <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
              {accept.isPending ? 'Joining…' : 'Accept invitation'}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
