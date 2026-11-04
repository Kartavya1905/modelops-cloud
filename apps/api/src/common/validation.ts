import { type PipeTransform, ValidationPipe, type ValidationError } from '@nestjs/common';
import { Errors, type FieldError } from './errors/app-error';

function flatten(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = Object.values(e.constraints ?? {}).map((message) => ({ field, message }));
    return [...own, ...flatten(e.children ?? [], field)];
  });
}

/**
 * Global request-body validation:
 *  - unknown properties are rejected (prevents mass assignment, e.g. sending `role: "OWNER"`)
 *  - failures become a 400 VALIDATION_FAILED problem listing every field
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors) => Errors.validation(flatten(errors)),
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Route-param pipe: a malformed id is reported as "not found", like an id from another tenant. */
export class UuidParam implements PipeTransform<string, string> {
  constructor(private readonly what = 'Resource') {}

  transform(value: string): string {
    if (!isUuid(value)) throw Errors.notFound(this.what);
    return value.toLowerCase();
  }
}
