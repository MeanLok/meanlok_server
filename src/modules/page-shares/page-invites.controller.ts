import { Controller, Delete, Get, Param, Query, UseGuards } from '@nestjs/common';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { WorkspacePageParamDto } from '../../common/dto/route-params.dto';
import { PageAccess } from '../../common/decorators/page-access.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageAccessGuard } from '../../common/guards/page-access.guard';
import { PageSharesService } from './page-shares.service';

@Controller('workspaces/:workspaceId/pages/:pageId/invites')
@UseGuards(JwtAuthGuard, PageAccessGuard)
@PageAccess('EDITOR')
export class PageInvitesController {
  constructor(private readonly pageSharesService: PageSharesService) {}

  @Get()
  list(
    @Param() params: WorkspacePageParamDto,
    @Query() query: PaginationQueryDto,
  ) {
    return this.pageSharesService.listPendingInvites(
      params.workspaceId,
      params.pageId,
      query,
    );
  }

  @Delete(':inviteId')
  remove(
    @Param() params: WorkspacePageParamDto,
    @Param('inviteId') inviteId: string,
  ) {
    return this.pageSharesService.revokeInvite(
      params.workspaceId,
      params.pageId,
      inviteId,
    );
  }
}
