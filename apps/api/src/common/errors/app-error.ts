import { HttpException, HttpStatus } from '@nestjs/common';

export interface FieldError {
  field: string;
  message: string;
}

/**
 * A domain error that maps 1:1 onto an RFC 9457 problem document (docs/04-api-specification.md).
 * `code` is the stable, machine-readable identifier clients switch on; `title` is fixed per
 * code; `detail` explains this specific occurrence.
 */
export class AppError extends HttpException {
  constructor(
    readonly httpStatus: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly fieldErrors?: FieldError[],
    readonly extraHeaders?: Record<string, string>,
  ) {
    super({ code, title, detail }, httpStatus);
  }
}

export const Errors = {
  validation: (fieldErrors: FieldError[]) =>
    new AppError(
      HttpStatus.BAD_REQUEST,
      'VALIDATION_FAILED',
      'Validation failed',
      'One or more fields are invalid.',
      fieldErrors,
    ),
  unauthenticated: () =>
    new AppError(
      HttpStatus.UNAUTHORIZED,
      'UNAUTHENTICATED',
      'Authentication required',
      'Sign in to continue.',
    ),
  invalidCredentials: () =>
    new AppError(
      HttpStatus.UNAUTHORIZED,
      'INVALID_CREDENTIALS',
      'Invalid credentials',
      'The email or password is incorrect.',
    ),
  forbiddenRole: (permission: string) =>
    new AppError(
      HttpStatus.FORBIDDEN,
      'FORBIDDEN_ROLE',
      'Insufficient role',
      `Your role in this organization does not grant "${permission}".`,
    ),
  forbidden: (code: string, detail: string) =>
    new AppError(HttpStatus.FORBIDDEN, code, 'Forbidden', detail),
  csrf: () =>
    new AppError(
      HttpStatus.FORBIDDEN,
      'CSRF_TOKEN_INVALID',
      'Invalid CSRF token',
      'Send the X-CSRF-Token header returned by /auth/me.',
    ),
  /** Also used for cross-tenant access, so ids cannot be probed (docs/06, SEC-7). */
  notFound: (what = 'Resource') =>
    new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'Not found', `${what} not found.`),
  conflict: (code: string, detail: string) =>
    new AppError(HttpStatus.CONFLICT, code, 'Conflict', detail),
  rateLimited: (retryAfterSeconds: number) =>
    new AppError(
      HttpStatus.TOO_MANY_REQUESTS,
      'RATE_LIMITED',
      'Too many requests',
      `Try again in ${retryAfterSeconds} seconds.`,
      undefined,
      { 'Retry-After': String(retryAfterSeconds) },
    ),
};
