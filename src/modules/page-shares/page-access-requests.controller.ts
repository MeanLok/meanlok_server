import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Profile } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { WorkspacePageParamDto } from '../../common/dto/route-params.dto';
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
  list(
    @Param() params: WorkspacePageParamDto,
    @Query() query: PaginationQueryDto,
  ) {
    return this.pageSharesService.listAccessRequests(
      params.workspaceId,
      params.pageId,
      query,
    );
  }

  @Patch(':requestId')
  handle(
    @Param() params: WorkspacePageParamDto,
    @Param('requestId') requestId: string,
    @CurrentUser() user: Profile,
    @Body() dto: HandlePageAccessRequestDto,
  ) {
    return this.pageSharesService.handleAccessRequest(
      params.workspaceId,
      params.pageId,
      requestId,
      user,
      dto.action,
    );
  }
}
