'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BoxesIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderKanbanIcon,
  LayoutDashboardIcon,
  LogOutIcon,
  MenuIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  UsersIcon,
} from 'lucide-react';
import Link from 'next/link';
import { notFound, useParams, usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { ErrorState, RoleBadge } from '@/components/common/states';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/primitives';
import { api, setCsrfToken, unwrap } from '@/lib/api/client';
import { useSession } from '@/lib/auth/session';
import { cn } from '@/lib/utils';

export function useOrgId(): string {
  const params = useParams<{ orgId: string }>();
  return params.orgId;
}

const NAV = [
  { href: '', label: 'Overview', icon: LayoutDashboardIcon, permission: 'org:read' },
  { href: 'projects', label: 'Projects', icon: FolderKanbanIcon, permission: 'project:read' },
  { href: 'members', label: 'Members', icon: UsersIcon, permission: 'member:read' },
  { href: 'approvals', label: 'Approvals', icon: ShieldCheckIcon, permission: 'approval:read' },
  { href: 'audit', label: 'Audit log', icon: ScrollTextIcon, permission: 'audit:read' },
] as const;

/** Sidebar + top bar for every page inside an organization. */
export function OrgShell({ children }: { children: ReactNode }) {
  const orgId = useOrgId();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const session = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

  const logout = useMutation({
    mutationFn: () => unwrap(api.POST('/api/v1/auth/logout')),
    onSettled: () => {
      setCsrfToken(null);
      queryClient.clear();
      router.replace('/login');
    },
  });

  const signedOut = session.isSuccess && session.data === null;
  useEffect(() => {
    // The cookie existed (proxy let us through) but the API says the session is gone.
    if (signedOut) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [signedOut, router, pathname]);

  if (session.isError) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <ErrorState error={session.error} onRetry={() => void session.refetch()} />
      </div>
    );
  }
  if (!session.data) {
    return (
      <div className="flex min-h-dvh items-center justify-center" aria-busy="true">
        <Skeleton className="h-8 w-48" />
      </div>
    );
  }

  const membership = session.data.memberships.find((m) => m.orgId === orgId);
  // Same answer as the API: an organization you don't belong to "does not exist".
  if (!membership) notFound();

  const nav = NAV.filter((n) => membership.permissions.includes(n.permission));
  const sidebar = (
    <nav aria-label="Organization" className="grid gap-1">
      {nav.map((item) => {
        const href = item.href ? `/orgs/${orgId}/${item.href}` : `/orgs/${orgId}`;
        // The overview is the org root: exact match only, or every page would highlight it.
        const active = item.href ? pathname.startsWith(href) : pathname === href;
        return (
          <Link
            key={item.href}
            href={href}
            onClick={() => setMobileOpen(false)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors hover:bg-accent',
              active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground',
            )}
          >
            <item.icon className="size-4" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 md:flex">
        <Link
          href={`/orgs/${orgId}/projects`}
          className="flex items-center gap-2 px-2 font-semibold"
        >
          <BoxesIcon className="size-5 text-primary" aria-hidden />
          ModelOps Cloud
        </Link>
        {sidebar}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-3 border-b px-4 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((o) => !o)}
          >
            <MenuIcon />
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                className="max-w-64 gap-2 px-2"
                aria-label="Switch organization"
              >
                <span className="truncate font-medium">{membership.orgName}</span>
                <RoleBadge role={membership.role} />
                <ChevronsUpDownIcon className="text-muted-foreground" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Organizations</DropdownMenuLabel>
              {session.data.memberships.map((m) => (
                <DropdownMenuItem
                  key={m.orgId}
                  onSelect={() => router.push(`/orgs/${m.orgId}/projects`)}
                >
                  <CheckIcon
                    className={cn(m.orgId === orgId ? 'opacity-100' : 'opacity-0')}
                    aria-hidden
                  />
                  <span className="truncate">{m.orgName}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="ml-auto">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 px-2" aria-label="Account menu">
                  <span
                    className="flex size-7 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary"
                    aria-hidden
                  >
                    {session.data.user.name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="hidden text-sm sm:inline">{session.data.user.name}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>{session.data.user.email}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => logout.mutate()}>
                  <LogOutIcon aria-hidden />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {mobileOpen && <div className="border-b bg-sidebar p-3 md:hidden">{sidebar}</div>}

        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">{children}</main>
      </div>
    </div>
  );
}
