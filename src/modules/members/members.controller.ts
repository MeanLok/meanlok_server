import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { WorkspaceParamDto } from '../../common/dto/route-params.dto';
import { WorkspaceRole } from '../../common/decorators/workspace-role.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../common/guards/workspace-role.guard';
import { UpdateMemberDto } from './dto/update-member.dto';
import { MembersService } from './members.service';

@Controller('workspaces/:workspaceId/members')
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class MembersController {
  constructor(private readonly membersService: MembersService) {}

  @Get()
  findAll(
    @Param() params: WorkspaceParamDto,
    @Query() query: PaginationQueryDto,
  ) {
    return this.membersService.findAll(params.workspaceId, query);
  }

  @WorkspaceRole(Role.OWNER)
  @Patch(':memberId')
  update(
    @Param() params: WorkspaceParamDto,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.membersService.update(params.workspaceId, memberId, dto);
  }

  @WorkspaceRole(Role.OWNER)
  @Delete(':memberId')
  remove(
    @Param() params: WorkspaceParamDto,
    @Param('memberId') memberId: string,
  ) {
    return this.membersService.remove(params.workspaceId, memberId);
  }
}
