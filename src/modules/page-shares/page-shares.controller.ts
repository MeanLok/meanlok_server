import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type { Profile } from '@prisma/client';
import { WorkspacePageParamDto } from '../../common/dto/route-params.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PageAccess } from '../../common/decorators/page-access.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageAccessGuard } from '../../common/guards/page-access.guard';
import { CreatePageShareDto } from './dto/create-page-share.dto';
import { UpdatePageShareDto } from './dto/update-page-share.dto';
import { PageSharesService } from './page-shares.service';

@Controller('workspaces/:workspaceId/pages/:pageId/shares')
@UseGuards(JwtAuthGuard, PageAccessGuard)
export class PageSharesController {
  constructor(private readonly pageSharesService: PageSharesService) {}

  @PageAccess('EDITOR')
  @Get()
  list(@Param() params: WorkspacePageParamDto) {
    return this.pageSharesService.listShares(params.workspaceId, params.pageId);
  }

  @PageAccess('EDITOR')
  @Post()
  create(
    @Param() params: WorkspacePageParamDto,
    @CurrentUser() user: Profile,
    @Body() dto: CreatePageShareDto,
  ) {
    return this.pageSharesService.addShare(
      params.workspaceId,
      params.pageId,
      user,
      dto,
    );
  }

  @PageAccess('EDITOR')
  @Patch(':shareId')
  update(
    @Param() params: WorkspacePageParamDto,
    @Param('shareId') shareId: string,
    @Body() dto: UpdatePageShareDto,
  ) {
    return this.pageSharesService.updateShare(
      params.workspaceId,
      params.pageId,
      shareId,
      dto,
    );
  }

  @PageAccess('EDITOR')
  @Delete(':shareId')
  remove(
    @Param() params: WorkspacePageParamDto,
    @Param('shareId') shareId: string,
  ) {
    return this.pageSharesService.removeShare(
      params.workspaceId,
      params.pageId,
      shareId,
    );
  }
}
