import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role, type Profile } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { WorkspaceParamDto } from '../../common/dto/route-params.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WorkspaceRole } from '../../common/decorators/workspace-role.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../common/guards/workspace-role.guard';
import { CreateInviteDto } from './dto/create-invite.dto';
import { InvitesService } from './invites.service';

@Controller('workspaces/:workspaceId/invites')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@WorkspaceRole(Role.OWNER)
export class WorkspaceInvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post()
  create(
    @Param() params: WorkspaceParamDto,
    @CurrentUser() user: Profile,
    @Body() dto: CreateInviteDto,
  ) {
    return this.invitesService.create(params.workspaceId, user, dto);
  }

  @Get()
  findPending(
    @Param() params: WorkspaceParamDto,
    @Query() query: PaginationQueryDto,
  ) {
    return this.invitesService.findPending(params.workspaceId, query);
  }

  @Delete(':inviteId')
  remove(
    @Param() params: WorkspaceParamDto,
    @Param('inviteId') inviteId: string,
  ) {
    return this.invitesService.remove(params.workspaceId, inviteId);
  }
}
