import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Errors } from './errors/app-error';

export class PageQuery {
  // Explicit `type`: a field with only an initializer gets design:type Object, which Swagger
  // would document as an empty object.
  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 25;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page’s `nextCursor`.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/** Cursors are opaque to clients: base64url-encoded JSON. */
export function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<K extends string>(
  cursor: string,
  keys: readonly K[],
): Record<K, string> {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null) {
      const obj = parsed as Record<string, unknown>;
      if (keys.every((k) => typeof obj[k] === 'string')) return obj as Record<K, string>;
    }
  } catch {
    // fall through
  }
  throw Errors.validation([{ field: 'cursor', message: 'cursor is invalid' }]);
}
