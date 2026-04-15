import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { InvitesService } from './invites.service';

@Controller('invites')
@UseGuards(JwtAuthGuard)
export class InvitePreviewController {
  constructor(private readonly invitesService: InvitesService) {}

  @Get(':token/preview')
  preview(@Param('token') token: string) {
    return this.invitesService.getInvitePreview(token);
  }
}
