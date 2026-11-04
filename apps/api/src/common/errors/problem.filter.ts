import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '../../generated/prisma/client';
import { AppError, type FieldError } from './app-error';

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  code: string;
  requestId?: string;
  errors?: FieldError[];
}

const GENERIC: Partial<Record<number, { code: string; title: string }>> = {
  400: { code: 'BAD_REQUEST', title: 'Bad request' },
  401: { code: 'UNAUTHENTICATED', title: 'Authentication required' },
  403: { code: 'FORBIDDEN', title: 'Forbidden' },
  404: { code: 'NOT_FOUND', title: 'Not found' },
  405: { code: 'METHOD_NOT_ALLOWED', title: 'Method not allowed' },
  413: { code: 'PAYLOAD_TOO_LARGE', title: 'Payload too large' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', title: 'Unsupported media type' },
  429: { code: 'RATE_LIMITED', title: 'Too many requests' },
};

function typeUri(code: string): string {
  return `https://modelops.local/problems/${code.toLowerCase().replaceAll('_', '-')}`;
}

/**
 * Converts every error into `application/problem+json` (RFC 9457).
 * Unexpected errors become a generic 500 that never leaks stack traces or internals;
 * the full error is logged with the request id so it can be found.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const problem = this.toProblem(exception, req);

    if (problem.status >= 500) {
      this.logger.error(
        `requestId=${problem.requestId ?? '-'} ${req.method} ${req.originalUrl}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }
    if (exception instanceof AppError && exception.extraHeaders) {
      for (const [k, v] of Object.entries(exception.extraHeaders)) res.setHeader(k, v);
    }
    // Stable, readable field order: what happened first, where it happened last.
    const { type, title, status, code, detail, errors, instance, requestId } = problem;
    res
      .status(status)
      .type('application/problem+json')
      .json({ type, title, status, code, detail, errors, instance, requestId });
  }

  private toProblem(exception: unknown, req: Request): ProblemDocument {
    const base = { instance: req.originalUrl, requestId: req.requestId };

    if (exception instanceof AppError) {
      return {
        ...base,
        type: typeUri(exception.code),
        title: exception.title,
        status: exception.httpStatus,
        code: exception.code,
        ...(exception.detail !== undefined && { detail: exception.detail }),
        ...(exception.fieldErrors && { errors: exception.fieldErrors }),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        return {
          ...base,
          type: typeUri('CONFLICT'),
          title: 'Conflict',
          status: 409,
          code: 'CONFLICT',
          detail: 'A resource with the same unique value already exists.',
        };
      }
      if (exception.code === 'P2025') {
        return {
          ...base,
          type: typeUri('NOT_FOUND'),
          title: 'Not found',
          status: 404,
          code: 'NOT_FOUND',
        };
      }
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const generic = GENERIC[status] ?? { code: 'HTTP_ERROR', title: 'Request failed' };
      return {
        ...base,
        type: typeUri(generic.code),
        title: generic.title,
        status,
        code: generic.code,
        detail: exception.message,
      };
    }

    return {
      ...base,
      type: typeUri('INTERNAL_ERROR'),
      title: 'Internal server error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      detail: 'An unexpected error occurred. Quote the requestId when reporting it.',
    };
  }
}
