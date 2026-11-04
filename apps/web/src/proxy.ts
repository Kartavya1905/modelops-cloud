import { type NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = new Set(['/login', '/register', '/status']);

/**
 * Optimistic auth redirect (Next.js 16 "Proxy", formerly Middleware).
 * Only checks that a session cookie *exists*, to avoid flashing app pages to signed-out users.
 * Real authentication and authorization happen in the API on every request.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.has(pathname) || request.cookies.has('mo_session')) {
    return NextResponse.next();
  }
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except the API proxy, Next.js internals and static files.
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|ico|txt)$).*)'],
};
