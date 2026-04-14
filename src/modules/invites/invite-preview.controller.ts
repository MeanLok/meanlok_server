import { Controller, Get, Param } from '@nestjs/common';
import { InvitesService } from './invites.service';

@Controller('invites')
export class InvitePreviewController {
  constructor(private readonly invitesService: InvitesService) {}

  @Get(':token/preview')
  preview(@Param('token') token: string) {
    return this.invitesService.getInvitePreview(token);
  }
}
