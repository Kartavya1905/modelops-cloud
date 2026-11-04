import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { DependencyCheck } from '../health.types';

/** Runs `SELECT 1` on the application's own Prisma connection pool. */
@Injectable()
export class PostgresCheck implements DependencyCheck {
  readonly name = 'postgres';

  constructor(private readonly prisma: PrismaService) {}

  async check(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }
}
