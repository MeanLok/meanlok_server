import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { RuntimeCacheService } from '../../common/runtime-cache/runtime-cache.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateMemberDto } from './dto/update-member.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  async findAll(workspaceId: string, query: PaginationQueryDto) {
    const offset = Math.max(0, Number(query.offset ?? 0));
    const requestedLimit = Number(query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.trunc(requestedLimit)))
      : 100;

    const chunk = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      skip: offset,
      take: limit + 1,
    });

    const hasMore = chunk.length > limit;
    const members = hasMore ? chunk.slice(0, limit) : chunk;

    return {
      items: members,
      nextOffset: hasMore ? offset + limit : null,
    };
  }

  async update(workspaceId: string, memberId: string, dto: UpdateMemberDto) {
    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        id: memberId,
        workspaceId,
      },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    if (member.role === Role.OWNER) {
      throw new ForbiddenException('Owner role cannot be changed');
    }

    const updated = await this.prisma.workspaceMember.update({
      where: { id: memberId },
      data: { role: dto.role },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    this.runtimeCache.invalidateWorkspace(workspaceId);
    return updated;
  }

  async remove(workspaceId: string, memberId: string) {
    const member = await this.prisma.workspaceMember.findFirst({
      where: {
        id: memberId,
        workspaceId,
      },
    });

    if (!member) {
      throw new NotFoundException('Member not found');
    }

    if (member.role === Role.OWNER) {
      throw new ForbiddenException('Owner cannot be removed');
    }

    await this.prisma.workspaceMember.delete({
      where: { id: memberId },
    });

    this.runtimeCache.invalidateWorkspace(workspaceId);

    return { ok: true };
  }
}
