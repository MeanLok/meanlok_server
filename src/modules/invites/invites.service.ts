import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Role, type Profile } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { RuntimeCacheService } from '../../common/runtime-cache/runtime-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { CreateInviteDto } from './dto/create-invite.dto';

@Injectable()
export class InvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  private hashToken(rawToken: string) {
    return createHash('sha256').update(rawToken).digest('hex');
  }

  private isSha256Hash(value: string | null): value is string {
    return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  }

  private toInviteOutput<T extends { tokenHash: string | null }>(invite: T, rawToken?: string) {
    const { tokenHash, ...rest } = invite;
    return {
      ...rest,
      token: rawToken ?? (tokenHash && !this.isSha256Hash(tokenHash) ? tokenHash : null),
    };
  }

  async create(workspaceId: string, inviter: Profile, dto: CreateInviteDto) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const rawToken = randomBytes(24).toString('base64url');
    const invite = await this.prisma.invite.create({
      data: {
        workspaceId,
        email: dto.email.toLowerCase(),
        role: dto.role ?? Role.EDITOR,
        tokenHash: this.hashToken(rawToken),
        inviterId: inviter.id,
        expiresAt,
      },
    });

    return this.toInviteOutput(invite, rawToken);
  }

  async findPending(workspaceId: string) {
    const invites = await this.prisma.invite.findMany({
      where: {
        workspaceId,
        acceptedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((invite) => this.toInviteOutput(invite));
  }

  async remove(workspaceId: string, inviteId: string) {
    const deleted = await this.prisma.invite.deleteMany({
      where: {
        id: inviteId,
        workspaceId,
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Invite not found');
    }

    return { ok: true };
  }

  async getInvitePreview(token: string) {
    const tokenHash = this.hashToken(token);
    let invite = await this.prisma.invite.findUnique({
      where: { tokenHash },
      include: {
        workspace: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!invite) {
      // 레거시 호환을 위한 이중 조회. 마이그레이션 완료 후 제거 예정.
      const legacyInvite = await this.prisma.invite.findUnique({
        where: { tokenHash: token },
        include: {
          workspace: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });
      invite = legacyInvite && !this.isSha256Hash(legacyInvite.tokenHash) ? legacyInvite : null;
    }

    if (!invite) {
      throw new NotFoundException('Invite not found');
    }

    if (invite.acceptedAt) {
      throw new BadRequestException('Invite already accepted');
    }

    if (invite.expiresAt <= new Date()) {
      throw new BadRequestException('Invite expired');
    }

    return {
      workspaceId: invite.workspace.id,
      workspaceName: invite.workspace.name,
      role: invite.role,
    };
  }

  async accept(user: Profile, dto: AcceptInviteDto) {
    const tokenHash = this.hashToken(dto.token);
    let invite = await this.prisma.invite.findUnique({
      where: { tokenHash },
    });

    if (!invite) {
      // 레거시 호환을 위한 이중 조회. 마이그레이션 완료 후 제거 예정.
      const legacyInvite = await this.prisma.invite.findUnique({
        where: { tokenHash: dto.token },
      });
      invite = legacyInvite && !this.isSha256Hash(legacyInvite.tokenHash) ? legacyInvite : null;
    }

    if (!invite) {
      throw new NotFoundException('Invite not found');
    }

    if (invite.acceptedAt) {
      throw new BadRequestException('Invite already accepted');
    }

    if (invite.expiresAt <= new Date()) {
      throw new BadRequestException('Invite expired');
    }

    if (invite.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new ForbiddenException('Invite email does not match user');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMember.upsert({
        where: {
          userId_workspaceId: {
            userId: user.id,
            workspaceId: invite.workspaceId,
          },
        },
        update: {
          role: invite.role,
        },
        create: {
          userId: user.id,
          workspaceId: invite.workspaceId,
          role: invite.role,
        },
      });

      await tx.invite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          tokenHash: null,
        },
      });
    });

    this.runtimeCache.invalidateWorkspace(invite.workspaceId);

    return {
      workspaceId: invite.workspaceId,
    };
  }
}
