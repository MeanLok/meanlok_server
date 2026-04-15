import {
  INestApplication,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient<Prisma.PrismaClientOptions, 'query' | 'warn' | 'error'>
  implements OnModuleInit
{
  private readonly logger = new Logger(PrismaService.name);
  private readonly slowQueryMs: number;

  constructor(private readonly configService: ConfigService) {
    const nodeEnv = (configService.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? '').trim();
    const isProduction = nodeEnv === 'production';

    super({
      log: isProduction
        ? [
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ]
        : [
            { emit: 'event', level: 'query' },
            { emit: 'stdout', level: 'warn' },
            { emit: 'stdout', level: 'error' },
          ],
    });

    const configured = Number(this.configService.get('PRISMA_SLOW_QUERY_MS') ?? 250);
    this.slowQueryMs = Number.isFinite(configured) ? Math.max(1, configured) : 250;

    if (!isProduction) {
      this.$on('query', (event: Prisma.QueryEvent) => {
        if (event.duration < this.slowQueryMs) {
          return;
        }

        const normalizedQuery = event.query.replace(/\s+/g, ' ').trim();
        const truncatedQuery =
          normalizedQuery.length > 280
            ? `${normalizedQuery.slice(0, 277)}...`
            : normalizedQuery;

        this.logger.warn(
          `Slow query (${event.duration}ms): ${truncatedQuery}`,
        );
      });
    }
  }

  async onModuleInit() {
    await this.$connect();
  }

  async enableShutdownHooks(app: INestApplication) {
    process.on('beforeExit', async () => {
      await app.close();
    });
  }
}
