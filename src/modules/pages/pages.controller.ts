import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Profile } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import {
  WorkspacePageParamDto,
  WorkspaceParamDto,
} from '../../common/dto/route-params.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PageAccess } from '../../common/decorators/page-access.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageAccessGuard } from '../../common/guards/page-access.guard';
import { CreatePageDto } from './dto/create-page.dto';
import { DuplicatePageDto } from './dto/duplicate-page.dto';
import { MovePageDto } from './dto/move-page.dto';
import { UpdatePageDto } from './dto/update-page.dto';
import { PagesService } from './pages.service';

@Controller('workspaces/:workspaceId/pages')
@UseGuards(JwtAuthGuard)
export class PagesController {
  constructor(private readonly pagesService: PagesService) {}

  @Post()
  create(
    @Param() params: WorkspaceParamDto,
    @CurrentUser() user: Profile,
    @Body() dto: CreatePageDto,
  ) {
    return this.pagesService.create(params.workspaceId, user, dto);
  }

  @Get()
  findAll(
    @Param() params: WorkspaceParamDto,
    @CurrentUser() user: Profile,
    @Query() query: PaginationQueryDto,
  ) {
    return this.pagesService.findAll(params.workspaceId, user, query);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('VIEWER')
  @Get(':pageId/meta')
  findMeta(
    @Param() params: WorkspacePageParamDto,
    @Req() request: any,
  ) {
    return this.pagesService
      .findMeta(params.workspaceId, params.pageId)
      .then((page) => ({
      ...page,
      accessRole: request.pageAccess?.role ?? 'VIEWER',
    }));
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('VIEWER')
  @Get(':pageId')
  findOne(
    @Param() params: WorkspacePageParamDto,
    @Req() request: any,
  ) {
    return this.pagesService
      .findOne(params.workspaceId, params.pageId)
      .then((page) => ({
      ...page,
      accessRole: request.pageAccess?.role ?? 'VIEWER',
    }));
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Patch(':pageId')
  update(
    @Param() params: WorkspacePageParamDto,
    @Body() dto: UpdatePageDto,
  ) {
    return this.pagesService.update(params.workspaceId, params.pageId, dto);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Delete(':pageId')
  remove(
    @Param() params: WorkspacePageParamDto,
  ) {
    return this.pagesService.remove(params.workspaceId, params.pageId);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Post(':pageId/duplicate')
  duplicate(
    @Param() params: WorkspacePageParamDto,
    @CurrentUser() user: Profile,
    @Body() dto: DuplicatePageDto,
  ) {
    return this.pagesService.duplicate(params.workspaceId, params.pageId, user, dto);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Post(':pageId/move')
  move(
    @Param() params: WorkspacePageParamDto,
    @CurrentUser() user: Profile,
    @Body() dto: MovePageDto,
  ) {
    return this.pagesService.move(params.workspaceId, params.pageId, user, dto);
  }
}
