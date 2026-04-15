import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';

const MINUTE_MS = 60_000;

type CleanupResult = {
  invites: number;
  pageInvites: number;
  aiDailyUsages: number;
};

@Injectable()
export class MaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const enabled = this.readBoolean('MAINTENANCE_ENABLED', true);
    if (!enabled) {
      this.logger.log('Maintenance scheduler disabled');
      return;
    }

    const intervalMinutes = this.readNumber('MAINTENANCE_INTERVAL_MINUTES', 60, 1);

    this.timer = setInterval(() => {
      void this.runCleanup();
    }, intervalMinutes * MINUTE_MS);
    this.timer.unref();

    // Run once shortly after bootstrap so old rows are cleaned up early.
    setTimeout(() => {
      void this.runCleanup();
    }, 10_000).unref();

    this.logger.log(`Maintenance scheduler started (interval: ${intervalMinutes}m)`);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private readBoolean(key: string, fallback: boolean) {
    const raw = this.configService.get<string | boolean>(key);
    if (typeof raw === 'boolean') {
      return raw;
    }

    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }

    return fallback;
  }

  private readNumber(key: string, fallback: number, min?: number) {
    const raw = this.configService.get<string | number>(key);
    const parsed = Number(raw);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    const value = Math.trunc(parsed);
    if (min !== undefined && value < min) {
      return min;
    }

    return value;
  }

  private async runCleanup() {
    const inviteRetentionDays = this.readNumber('INVITE_RETENTION_DAYS', 30, 1);
    const aiUsageRetentionDays = this.readNumber('AI_USAGE_RETENTION_DAYS', 90, 1);

    const now = new Date();

    const inviteAcceptedCutoff = new Date(now);
    inviteAcceptedCutoff.setDate(inviteAcceptedCutoff.getDate() - inviteRetentionDays);

    const aiUsageCutoff = new Date(now);
    aiUsageCutoff.setDate(aiUsageCutoff.getDate() - aiUsageRetentionDays);

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const [invites, pageInvites, aiDailyUsages] = await Promise.all([
          tx.invite.deleteMany({
            where: {
              OR: [
                {
                  acceptedAt: {
                    not: null,
                    lt: inviteAcceptedCutoff,
                  },
                },
                {
                  acceptedAt: null,
                  expiresAt: {
                    lt: now,
                  },
                },
              ],
            },
          }),
          tx.pageInvite.deleteMany({
            where: {
              OR: [
                {
                  acceptedAt: {
                    not: null,
                    lt: inviteAcceptedCutoff,
                  },
                },
                {
                  acceptedAt: null,
                  expiresAt: {
                    lt: now,
                  },
                },
              ],
            },
          }),
          tx.aiDailyUsage.deleteMany({
            where: {
              updatedAt: {
                lt: aiUsageCutoff,
              },
            },
          }),
        ]);

        return {
          invites: invites.count,
          pageInvites: pageInvites.count,
          aiDailyUsages: aiDailyUsages.count,
        } satisfies CleanupResult;
      });

      if (
        result.invites > 0 ||
        result.pageInvites > 0 ||
        result.aiDailyUsages > 0
      ) {
        this.logger.log(
          `Maintenance cleanup done (invites=${result.invites}, pageInvites=${result.pageInvites}, aiDailyUsages=${result.aiDailyUsages})`,
        );
      }
    } catch (error) {
      this.logger.error('Maintenance cleanup failed', error as Error);
    }
  }
}
