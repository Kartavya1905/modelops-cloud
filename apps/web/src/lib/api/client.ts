import type { paths } from '@modelops/api-contract';
import createClient, { type Middleware } from 'openapi-fetch';

/** RFC 9457 problem document returned by the API for every error. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  errors?: { field: string; message: string }[];
  requestId?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem,
  ) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
  }

  /** Field -> first message, for showing server-side validation errors next to inputs. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) out[e.field] ??= e.message;
    return out;
  }
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Problem).code === 'string' &&
    typeof (value as Problem).status === 'number'
  );
}

// ---- CSRF ------------------------------------------------------------------
// The token comes from /auth/me (or login/register) and is kept in memory only: never in
// localStorage, where an XSS bug could read it later.
let csrfToken: string | null = null;
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

const csrfMiddleware: Middleware = {
  onRequest({ request }) {
    if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      request.headers.set('X-CSRF-Token', csrfToken);
    }
    return request;
  },
};

/**
 * Typed client generated from the API's OpenAPI document (packages/api-contract).
 * Paths, params, bodies and responses are all checked at compile time.
 * Requests go to the same origin; Next.js rewrites /api/* to the NestJS API.
 */
export const api = createClient<paths>({
  baseUrl: typeof window === 'undefined' ? 'http://127.0.0.1' : window.location.origin,
  credentials: 'same-origin',
  // Look fetch up at call time (openapi-fetch otherwise captures it at import), so tests and
  // instrumentation can wrap it.
  fetch: (request) => globalThis.fetch(request),
});
api.use(csrfMiddleware);

/** Returns `data` or throws ApiError (always with a problem document, even for proxy errors). */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  const { data, error, response } = await call;
  if (response.ok) return data as T;
  const problem: Problem = isProblem(error)
    ? error
    : {
        type: 'about:blank',
        title: response.status >= 500 ? 'Service unavailable' : 'Request failed',
        status: response.status,
        code: response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'HTTP_ERROR',
        detail:
          response.status >= 500
            ? 'The API is not reachable right now. Try again in a moment.'
            : `Unexpected response (HTTP ${String(response.status)}).`,
      };
  throw new ApiError(response.status, problem);
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.problem.detail ?? err.problem.title;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}
