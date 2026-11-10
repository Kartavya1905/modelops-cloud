import { HttpStatus } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error';

/**
 * Optimistic locking on endpoints (docs/04 "Concurrency"): every traffic change carries the ETag
 * the caller last saw (`If-Match: W/"<rowVersion>"`). A missing header is 428, a stale one 412, so
 * two people (or one double click) can never apply a change to a state they did not see.
 */
export function expectedRowVersion(ifMatch: string | undefined): number {
  const expected = /^W\/"(\d+)"$/.exec(ifMatch ?? '')?.[1];
  if (expected === undefined) {
    throw new AppError(
      HttpStatus.PRECONDITION_REQUIRED,
      'IF_MATCH_REQUIRED',
      'If-Match header required',
      'Send the ETag from GET /endpoints/{id} as If-Match.',
    );
  }
  return Number(expected);
}

export const staleEtag = () =>
  new AppError(
    HttpStatus.PRECONDITION_FAILED,
    'ETAG_MISMATCH',
    'The endpoint changed meanwhile',
    'Reload it and apply your change again.',
  );
