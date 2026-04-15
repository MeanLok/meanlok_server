import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Profile } from '@prisma/client';
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
    @Param('workspaceId') workspaceId: string,
    @CurrentUser() user: Profile,
    @Body() dto: CreatePageDto,
  ) {
    return this.pagesService.create(workspaceId, user, dto);
  }

  @Get()
  findAll(@Param('workspaceId') workspaceId: string, @CurrentUser() user: Profile) {
    return this.pagesService.findAll(workspaceId, user);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('VIEWER')
  @Get(':pageId/meta')
  findMeta(
    @Param('workspaceId') workspaceId: string,
    @Param('pageId') pageId: string,
    @Req() request: any,
  ) {
    return this.pagesService.findMeta(workspaceId, pageId).then((page) => ({
      ...page,
      accessRole: request.pageAccess?.role ?? 'VIEWER',
    }));
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('VIEWER')
  @Get(':pageId')
  findOne(
    @Param('workspaceId') workspaceId: string,
    @Param('pageId') pageId: string,
    @Req() request: any,
  ) {
    return this.pagesService.findOne(workspaceId, pageId).then((page) => ({
      ...page,
      accessRole: request.pageAccess?.role ?? 'VIEWER',
    }));
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Patch(':pageId')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('pageId') pageId: string,
    @Body() dto: UpdatePageDto,
  ) {
    return this.pagesService.update(workspaceId, pageId, dto);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Delete(':pageId')
  remove(
    @Param('workspaceId') workspaceId: string,
    @Param('pageId') pageId: string,
  ) {
    return this.pagesService.remove(workspaceId, pageId);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Post(':pageId/duplicate')
  duplicate(
    @Param('workspaceId') workspaceId: string,
    @Param('pageId') pageId: string,
    @CurrentUser() user: Profile,
    @Body() dto: DuplicatePageDto,
  ) {
    return this.pagesService.duplicate(workspaceId, pageId, user, dto);
  }

  @UseGuards(PageAccessGuard)
  @PageAccess('EDITOR')
  @Post(':pageId/move')
  move(
    @Param('workspaceId') workspaceId: string,
    @Param('pageId') pageId: string,
    @CurrentUser() user: Profile,
    @Body() dto: MovePageDto,
  ) {
    return this.pagesService.move(workspaceId, pageId, user, dto);
  }
}
