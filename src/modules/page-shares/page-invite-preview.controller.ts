import { Controller, Get, Param } from '@nestjs/common';
import { PageSharesService } from './page-shares.service';

@Controller('page-invites')
export class PageInvitePreviewController {
  constructor(private readonly pageSharesService: PageSharesService) {}

  @Get(':token/preview')
  preview(@Param('token') token: string) {
    return this.pageSharesService.getInvitePreview(token);
  }
}
