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
import { Role, type Profile } from '@prisma/client';
import { WorkspaceParamDto } from '../../common/dto/route-params.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WorkspaceRole } from '../../common/decorators/workspace-role.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../common/guards/workspace-role.guard';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';
import { WorkspacesService } from './workspaces.service';

@Controller('workspaces')
@UseGuards(JwtAuthGuard)
export class WorkspacesController {
  constructor(private readonly workspacesService: WorkspacesService) {}

  @Post()
  create(@CurrentUser() user: Profile, @Body() dto: CreateWorkspaceDto) {
    return this.workspacesService.create(user, dto);
  }

  @Get()
  findAll(@CurrentUser() user: Profile) {
    return this.workspacesService.findAll(user);
  }

  @UseGuards(WorkspaceRoleGuard)
  @Get(':workspaceId')
  findOne(@Param() params: WorkspaceParamDto, @CurrentUser() user: Profile) {
    return this.workspacesService.findOne(params.workspaceId, user.id);
  }

  @Get(':workspaceId/public-info')
  getPublicInfo(
    @Param() params: WorkspaceParamDto,
    @CurrentUser() user: Profile,
  ) {
    return this.workspacesService.getPublicInfo(params.workspaceId, user);
  }

  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRole(Role.OWNER)
  @Patch(':workspaceId')
  update(
    @Param() params: WorkspaceParamDto,
    @Body() dto: UpdateWorkspaceDto,
  ) {
    return this.workspacesService.update(params.workspaceId, dto);
  }

  @UseGuards(WorkspaceRoleGuard)
  @WorkspaceRole(Role.OWNER)
  @Delete(':workspaceId')
  remove(@Param() params: WorkspaceParamDto) {
    return this.workspacesService.remove(params.workspaceId);
  }
}
