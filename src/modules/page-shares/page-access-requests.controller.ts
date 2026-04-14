import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import type { Profile } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PageAccess } from '../../common/decorators/page-access.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageAccessGuard } from '../../common/guards/page-access.guard';
import {
  HandlePageAccessRequestDto,
} from './dto/handle-page-access-request.dto';
import { PageSharesService } from './page-shares.service';

@Controller('workspaces/:workspaceId/pages/:pageId/access-requests')
@UseGuards(JwtAuthGuard, PageAccessGuard)
@PageAccess('EDITOR')
export class PageAccessRequestsController {
  constructor(private readonly pageSharesService: PageSharesService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string, @Param('pageId') pageId: string) {
    return this.pageSharesService.listAccessRequests(workspaceId, pageId);
  }

  @Patch(':requestId')
  handle(
    @Param('workspaceId') workspaceId: string,
    @Param('pageId') pageId: string,
    @Param('requestId') requestId: string,
    @CurrentUser() user: Profile,
    @Body() dto: HandlePageAccessRequestDto,
  ) {
    return this.pageSharesService.handleAccessRequest(
      workspaceId,
      pageId,
      requestId,
      user,
      dto.action,
    );
  }
}
