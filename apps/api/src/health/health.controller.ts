import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../modules/auth/auth.guards';
import { HealthService } from './health.service';
import type { ReadinessReport } from './health.types';

/**
 * GET /api/v1/health/live   -> 200 while the process is running (used for restarts)
 * GET /api/v1/health/ready  -> 200 when every dependency is up, 503 otherwise (used for routing traffic)
 */
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ description: 'Process is running.' })
  live(): ReturnType<HealthService['liveness']> {
    return this.health.liveness();
  }

  @Get('ready')
  @ApiOkResponse({ description: 'All dependencies are up.' })
  @ApiServiceUnavailableResponse({ description: 'At least one dependency is down.' })
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    res.status(report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
