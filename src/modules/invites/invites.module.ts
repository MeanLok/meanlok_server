import { Module } from '@nestjs/common';
import { InvitePreviewController } from './invite-preview.controller';
import { InvitesController } from './invites.controller';
import { WorkspaceInvitesController } from './workspace-invites.controller';
import { InvitesService } from './invites.service';

@Module({
  controllers: [WorkspaceInvitesController, InvitePreviewController, InvitesController],
  providers: [InvitesService],
})
export class InvitesModule {}
