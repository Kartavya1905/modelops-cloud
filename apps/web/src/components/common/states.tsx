'use client';

import type { Permission } from '@modelops/api-contract';
import { AlertTriangleIcon, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Badge, Skeleton } from '@/components/ui/primitives';
import { errorMessage } from '@/lib/api/client';
import { useCan } from '@/lib/auth/session';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-14 text-center">
      <div className="rounded-full bg-muted p-3">
        <Icon className="size-6 text-muted-foreground" aria-hidden />
      </div>
      <div className="grid gap-1">
        <h2 className="font-medium">{title}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-6 py-10 text-center"
    >
      <AlertTriangleIcon className="size-6 text-destructive" aria-hidden />
      <p className="text-sm">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid gap-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

/** Renders children only if the signed-in user's role grants `permission` (UI hint only). */
export function PermissionGate({
  orgId,
  permission,
  children,
  fallback = null,
}: {
  orgId: string;
  permission: Permission;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useCan(orgId, permission) ? children : fallback;
}

const ROLE_LABEL = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  ML_ENGINEER: 'ML Engineer',
  VIEWER: 'Viewer',
} as const;

export function roleLabel(role: keyof typeof ROLE_LABEL): string {
  return ROLE_LABEL[role];
}

export function RoleBadge({ role }: { role: keyof typeof ROLE_LABEL }) {
  return (
    <Badge variant={role === 'OWNER' ? 'default' : role === 'VIEWER' ? 'outline' : 'secondary'}>
      {ROLE_LABEL[role]}
    </Badge>
  );
}
