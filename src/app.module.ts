import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import configuration from './config/configuration';
import { AccessModule } from './common/access.module';
import { ObservabilityModule } from './common/observability/observability.module';
import { RuntimeCacheModule } from './common/runtime-cache/runtime-cache.module';
import { PrismaModule } from './prisma/prisma.module';
import { SanitizeModule } from './shared/sanitize/sanitize.module';
import { AuthModule } from './modules/auth/auth.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';
import { MembersModule } from './modules/members/members.module';
import { InvitesModule } from './modules/invites/invites.module';
import { PagesModule } from './modules/pages/pages.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { AiModule } from './modules/ai/ai.module';
import { PageSharesModule } from './modules/page-shares/page-shares.module';
import { MaintenanceModule } from './modules/maintenance/maintenance.module';
import { OpsModule } from './modules/ops/ops.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 100,
      },
    ]),
    ObservabilityModule,
    RuntimeCacheModule,
    PrismaModule,
    AccessModule,
    SanitizeModule,
    AuthModule,
    WorkspacesModule,
    MembersModule,
    InvitesModule,
    PagesModule,
    DocumentsModule,
    AiModule,
    PageSharesModule,
    MaintenanceModule,
    OpsModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
