import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Role, type Profile } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AcceptInviteDto } from './dto/accept-invite.dto';
import { CreateInviteDto } from './dto/create-invite.dto';

@Injectable()
export class InvitesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(workspaceId: string, inviter: Profile, dto: CreateInviteDto) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    return this.prisma.invite.create({
      data: {
        workspaceId,
        email: dto.email.toLowerCase(),
        role: dto.role ?? Role.EDITOR,
        token: randomBytes(24).toString('hex'),
        inviterId: inviter.id,
        expiresAt,
      },
    });
  }

  async findPending(workspaceId: string) {
    return this.prisma.invite.findMany({
      where: {
        workspaceId,
        acceptedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: { createdAt: 'desc' },
    });
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
    const invite = await this.prisma.invite.findUnique({
      where: { token },
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
    const invite = await this.prisma.invite.findUnique({
      where: { token: dto.token },
    });

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
        },
      });
    });

    return {
      workspaceId: invite.workspaceId,
    };
  }
}
