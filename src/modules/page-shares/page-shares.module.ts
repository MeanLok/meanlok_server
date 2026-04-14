import { Module } from '@nestjs/common';
import { PageAccessRequestsController } from './page-access-requests.controller';
import { PageInviteAcceptController } from './page-invite-accept.controller';
import { PageInvitePreviewController } from './page-invite-preview.controller';
import { PageInvitesController } from './page-invites.controller';
import { PageSharesController } from './page-shares.controller';
import { PageSharesService } from './page-shares.service';

@Module({
  controllers: [
    PageSharesController,
    PageInvitesController,
    PageInvitePreviewController,
    PageAccessRequestsController,
    PageInviteAcceptController,
  ],
  providers: [PageSharesService],
})
export class PageSharesModule {}
