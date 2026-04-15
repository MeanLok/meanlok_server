import { Injectable, NotFoundException } from '@nestjs/common';
import { Role, type Profile } from '@prisma/client';
import { AccessService } from '../../common/services/access.service';
import { RuntimeCacheService } from '../../common/runtime-cache/runtime-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateWorkspaceDto } from './dto/create-workspace.dto';
import { UpdateWorkspaceDto } from './dto/update-workspace.dto';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  async create(user: Profile, dto: CreateWorkspaceDto) {
    const workspace = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: dto.name,
          ownerId: user.id,
        },
      });

      await tx.workspaceMember.create({
        data: {
          workspaceId: workspace.id,
          userId: user.id,
          role: Role.OWNER,
        },
      });

      return workspace;
    });

    this.runtimeCache.invalidateWorkspace(workspace.id);
    return workspace;
  }

  async findAll(user: Profile) {
    return this.prisma.workspace.findMany({
      where: {
        members: {
          some: {
            userId: user.id,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async findOne(workspaceId: string, requesterId?: string) {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    if (requesterId && requesterId !== workspace.ownerId) {
      const { owner, ...rest } = workspace;
      const { email: _email, ...ownerWithoutEmail } = owner;
      return {
        ...rest,
        owner: ownerWithoutEmail,
      };
    }

    return workspace;
  }

  async getPublicInfo(workspaceId: string, user: Profile) {
    const memberRole = await this.accessService.getWorkspaceMemberRole(user.id, workspaceId);
    const hasPageShare = await this.prisma.pageShare.findFirst({
      where: {
        userId: user.id,
        page: {
          workspaceId,
        },
      },
      select: {
        id: true,
      },
    });

    if (!memberRole && !hasPageShare) {
      throw new NotFoundException('Workspace not found');
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
      },
    });

    if (!workspace) {
      throw new NotFoundException('Workspace not found');
    }

    return workspace;
  }

  async update(workspaceId: string, dto: UpdateWorkspaceDto) {
    const workspace = await this.prisma.workspace.updateMany({
      where: { id: workspaceId },
      data: dto,
    });

    if (workspace.count === 0) {
      throw new NotFoundException('Workspace not found');
    }

    const updatedWorkspace = await this.findOne(workspaceId);
    this.runtimeCache.invalidateWorkspace(workspaceId);
    return updatedWorkspace;
  }

  async remove(workspaceId: string) {
    const deleted = await this.prisma.workspace.deleteMany({
      where: { id: workspaceId },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Workspace not found');
    }

    this.runtimeCache.invalidateWorkspace(workspaceId);

    return { ok: true };
  }
}
