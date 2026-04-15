import {
  Controller,
  ForbiddenException,
  Get,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RuntimeMetricsService } from '../../common/observability/runtime-metrics.service';

@Controller('ops')
@UseGuards(JwtAuthGuard)
export class OpsController {
  constructor(
    private readonly metrics: RuntimeMetricsService,
    private readonly configService: ConfigService,
  ) {}

  @Get('metrics')
  getMetrics(@Req() req: Request & { user?: { email?: string } }) {
    const adminEmails = this.configService.get<string[]>('adminEmails') ?? [];
    const requesterEmail = req.user?.email?.trim().toLowerCase();

    if (!requesterEmail || !adminEmails.includes(requesterEmail)) {
      throw new ForbiddenException('Admins only');
    }

    return this.metrics.snapshot();
  }
}
