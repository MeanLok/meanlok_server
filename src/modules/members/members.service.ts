import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { RuntimeCacheService } from '../../common/runtime-cache/runtime-cache.service';
import { Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateMemberDto } from './dto/update-member.dto';

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  async findAll(workspaceId: string) {
    return this.prisma.workspaceMember.findMany({
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
      orderBy: { createdAt: 'asc' },
    });
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
