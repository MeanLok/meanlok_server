import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageSharesService } from './page-shares.service';

@Controller('page-invites')
@UseGuards(JwtAuthGuard)
export class PageInvitePreviewController {
  constructor(private readonly pageSharesService: PageSharesService) {}

  @Get(':token/preview')
  preview(@Param('token') token: string) {
    return this.pageSharesService.getInvitePreview(token);
  }
}
