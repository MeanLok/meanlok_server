import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  LinkInviteMode,
  PageAccessRequestStatus,
  PageRole,
  type Profile,
} from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { RuntimeCacheService } from '../../common/runtime-cache/runtime-cache.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AcceptPageInviteDto } from './dto/accept-page-invite.dto';
import { CreatePageShareDto } from './dto/create-page-share.dto';
import {
  PageAccessRequestAction,
} from './dto/handle-page-access-request.dto';
import { UpdatePageShareDto } from './dto/update-page-share.dto';

const PAGE_ROLE_PRIORITY: Record<PageRole, number> = {
  [PageRole.EDITOR]: 2,
  [PageRole.VIEWER]: 1,
};

@Injectable()
export class PageSharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {}

  private invalidateAccess(workspaceId: string, pageId: string) {
    this.runtimeCache.invalidateWorkspace(workspaceId);
    this.runtimeCache.invalidatePage(pageId);
  }

  private async getPageOrThrow(workspaceId: string, pageId: string) {
    const page = await this.prisma.page.findFirst({
      where: {
        id: pageId,
        workspaceId,
      },
      select: {
        id: true,
        title: true,
        parentId: true,
        workspaceId: true,
      },
    });

    if (!page) {
      throw new NotFoundException('Page not found');
    }

    return page;
  }

  private async listAncestorPages(
    pageId: string,
  ): Promise<Array<{ id: string; title: string; parentId: string | null }>> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; parentId: string | null; depth: number }>
    >`
      WITH RECURSIVE ancestors AS (
        SELECT p.id, p.title, p."parentId", 0::int AS depth
        FROM "Page" p
        WHERE p.id = ${pageId}
        UNION ALL
        SELECT parent.id, parent.title, parent."parentId", ancestors.depth + 1
        FROM "Page" parent
        INNER JOIN ancestors ON ancestors."parentId" = parent.id
      )
      SELECT id, title, "parentId", depth
      FROM ancestors
      WHERE depth > 0
      ORDER BY depth ASC
    `;

    return rows.map(({ id, title, parentId }) => ({ id, title, parentId }));
  }

  private normalizeEmail(email: string) {
    return email.trim().toLowerCase();
  }

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

  private createLinkOnlyInviteEmail() {
    return `link-${randomBytes(8).toString('hex')}@share.meanlok.local`;
  }

  private isLinkOnlyInviteEmail(email: string) {
    return email.startsWith('link-') && email.endsWith('@share.meanlok.local');
  }

  private async createInvite(params: {
    pageId: string;
    email: string;
    role: PageRole;
    inviterId: string;
  }) {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7);

    const rawToken = randomBytes(24).toString('base64url');
    const invite = await this.prisma.pageInvite.create({
      data: {
        pageId: params.pageId,
        email: params.email,
        role: params.role,
        tokenHash: this.hashToken(rawToken),
        inviterId: params.inviterId,
        expiresAt,
      },
      include: {
        inviter: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    return this.toInviteOutput(invite, rawToken);
  }

  private shareOutput(share: {
    id: string;
    role: PageRole;
    createdAt: Date;
    user: { id: string; email: string; name: string };
  }) {
    return {
      id: share.id,
      role: share.role,
      user: share.user,
      createdAt: share.createdAt,
    };
  }

  private accessRequestOutput(request: {
    id: string;
    role: PageRole;
    status: PageAccessRequestStatus;
    createdAt: Date;
    user: { id: string; email: string; name: string };
  }) {
    return {
      id: request.id,
      role: request.role,
      status: request.status,
      createdAt: request.createdAt,
      user: request.user,
    };
  }

  async listShares(workspaceId: string, pageId: string) {
    const page = await this.getPageOrThrow(workspaceId, pageId);

    const directShares = await this.prisma.pageShare.findMany({
      where: { pageId },
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

    const ancestorPages = await this.listAncestorPages(page.id);

    const inheritedShares =
      ancestorPages.length === 0
        ? []
        : await this.prisma.pageShare.findMany({
            where: {
              pageId: {
                in: ancestorPages.map((ancestor) => ancestor.id),
              },
            },
            include: {
              user: {
                select: {
                  id: true,
                  email: true,
                  name: true,
                },
              },
            },
            orderBy: { createdAt: 'desc' },
          });

    const ancestorTitleMap = new Map(ancestorPages.map((ancestor) => [ancestor.id, ancestor.title]));
    const directUserIds = new Set(directShares.map((share) => share.userId));

    const inheritedByUser = new Map<
      string,
      {
        role: PageRole;
        user: { id: string; email: string; name: string };
        sourcePage: { id: string; title: string };
        createdAt: Date;
      }
    >();

    for (const share of inheritedShares) {
      if (directUserIds.has(share.userId)) {
        continue;
      }

      const title = ancestorTitleMap.get(share.pageId);
      if (!title) {
        continue;
      }

      const existing = inheritedByUser.get(share.userId);
      if (
        !existing ||
        PAGE_ROLE_PRIORITY[share.role] > PAGE_ROLE_PRIORITY[existing.role] ||
        (share.role === existing.role && share.createdAt > existing.createdAt)
      ) {
        inheritedByUser.set(share.userId, {
          role: share.role,
          user: share.user,
          sourcePage: {
            id: share.pageId,
            title,
          },
          createdAt: share.createdAt,
        });
      }
    }

    return {
      direct: directShares.map((share) => this.shareOutput(share)),
      inherited: [...inheritedByUser.values()],
    };
  }

  async addShare(
    workspaceId: string,
    pageId: string,
    inviter: Profile,
    dto: CreatePageShareDto,
  ) {
    await this.getPageOrThrow(workspaceId, pageId);

    if (dto.userId && dto.email) {
      throw new BadRequestException('Provide either userId or email');
    }

    if (dto.userId) {
      const profile = await this.prisma.profile.findUnique({
        where: { id: dto.userId },
        select: { id: true },
      });

      if (!profile) {
        throw new NotFoundException('User not found');
      }

      const share = await this.prisma.pageShare.upsert({
        where: {
          pageId_userId: {
            pageId,
            userId: dto.userId,
          },
        },
        create: {
          pageId,
          userId: dto.userId,
          role: dto.role,
        },
        update: {
          role: dto.role,
        },
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

      this.invalidateAccess(workspaceId, pageId);
      return {
        kind: 'share' as const,
        data: this.shareOutput(share),
      };
    }

    const email = dto.email ? this.normalizeEmail(dto.email) : null;

    if (email) {
      const profile = await this.prisma.profile.findFirst({
        where: {
          email: {
            equals: email,
            mode: 'insensitive',
          },
        },
        select: {
          id: true,
        },
      });

      if (profile) {
        const share = await this.prisma.pageShare.upsert({
          where: {
            pageId_userId: {
              pageId,
              userId: profile.id,
            },
          },
          create: {
            pageId,
            userId: profile.id,
            role: dto.role,
          },
          update: {
            role: dto.role,
          },
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

        this.invalidateAccess(workspaceId, pageId);
        return {
          kind: 'share' as const,
          data: this.shareOutput(share),
        };
      }
    }

    const invite = await this.createInvite({
      pageId,
      email: email ?? this.createLinkOnlyInviteEmail(),
      role: dto.role,
      inviterId: inviter.id,
    });

    return {
      kind: 'invite' as const,
      data: invite,
    };
  }

  async updateShare(
    workspaceId: string,
    pageId: string,
    shareId: string,
    dto: UpdatePageShareDto,
  ) {
    const share = await this.prisma.pageShare.findUnique({
      where: { id: shareId },
      select: {
        id: true,
        pageId: true,
        page: {
          select: {
            workspaceId: true,
          },
        },
      },
    });

    if (!share || share.pageId !== pageId || share.page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page share not found');
    }

    const updated = await this.prisma.pageShare.update({
      where: { id: shareId },
      data: {
        role: dto.role,
      },
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

    this.invalidateAccess(workspaceId, pageId);
    return this.shareOutput(updated);
  }

  async removeShare(workspaceId: string, pageId: string, shareId: string) {
    const deleted = await this.prisma.pageShare.deleteMany({
      where: {
        id: shareId,
        pageId,
        page: {
          workspaceId,
        },
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Page share not found');
    }

    this.invalidateAccess(workspaceId, pageId);
    return { ok: true };
  }

  async listPendingInvites(
    workspaceId: string,
    pageId: string,
    query: PaginationQueryDto,
  ) {
    await this.getPageOrThrow(workspaceId, pageId);

    const offset = Math.max(0, Number(query.offset ?? 0));
    const requestedLimit = Number(query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.trunc(requestedLimit)))
      : 100;

    const chunk = await this.prisma.pageInvite.findMany({
      where: {
        pageId,
        acceptedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      include: {
        inviter: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip: offset,
      take: limit + 1,
    });

    const hasMore = chunk.length > limit;
    const invites = hasMore ? chunk.slice(0, limit) : chunk;

    return {
      items: invites.map((invite) => this.toInviteOutput(invite)),
      nextOffset: hasMore ? offset + limit : null,
    };
  }

  async listAccessRequests(
    workspaceId: string,
    pageId: string,
    query: PaginationQueryDto,
  ) {
    await this.getPageOrThrow(workspaceId, pageId);

    const offset = Math.max(0, Number(query.offset ?? 0));
    const requestedLimit = Number(query.limit ?? 100);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(200, Math.max(1, Math.trunc(requestedLimit)))
      : 100;

    const chunk = await this.prisma.pageAccessRequest.findMany({
      where: {
        pageId,
        status: PageAccessRequestStatus.PENDING,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
      skip: offset,
      take: limit + 1,
    });

    const hasMore = chunk.length > limit;
    const requests = hasMore ? chunk.slice(0, limit) : chunk;

    return {
      items: requests.map((request) => this.accessRequestOutput(request)),
      nextOffset: hasMore ? offset + limit : null,
    };
  }

  async handleAccessRequest(
    workspaceId: string,
    pageId: string,
    requestId: string,
    handler: Profile,
    action: PageAccessRequestAction,
  ) {
    const request = await this.prisma.pageAccessRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        pageId: true,
        role: true,
        userId: true,
        status: true,
        page: {
          select: {
            workspaceId: true,
          },
        },
      },
    });

    if (!request || request.pageId !== pageId || request.page.workspaceId !== workspaceId) {
      throw new NotFoundException('Page access request not found');
    }

    if (request.status !== PageAccessRequestStatus.PENDING) {
      throw new BadRequestException('Page access request already handled');
    }

    if (action === PageAccessRequestAction.APPROVE) {
      await this.prisma.$transaction(async (tx) => {
        await tx.pageShare.upsert({
          where: {
            pageId_userId: {
              pageId,
              userId: request.userId,
            },
          },
          create: {
            pageId,
            userId: request.userId,
            role: request.role,
          },
          update: {
            role: request.role,
          },
        });

        await tx.pageAccessRequest.update({
          where: { id: request.id },
          data: {
            status: PageAccessRequestStatus.APPROVED,
            handledById: handler.id,
            handledAt: new Date(),
          },
        });
      });

      this.invalidateAccess(workspaceId, pageId);
      return { ok: true };
    }

    await this.prisma.pageAccessRequest.update({
      where: { id: request.id },
      data: {
        status: PageAccessRequestStatus.REJECTED,
        handledById: handler.id,
        handledAt: new Date(),
      },
    });

    return { ok: true };
  }

  async revokeInvite(workspaceId: string, pageId: string, inviteId: string) {
    const deleted = await this.prisma.pageInvite.deleteMany({
      where: {
        id: inviteId,
        pageId,
        page: {
          workspaceId,
        },
      },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Page invite not found');
    }

    return { ok: true };
  }

  async getInvitePreview(token: string) {
    const tokenHash = this.hashToken(token);
    let invite = await this.prisma.pageInvite.findUnique({
      where: { tokenHash },
      include: {
        page: {
          select: {
            id: true,
            title: true,
            workspace: {
              select: {
                id: true,
                name: true,
                linkInviteMode: true,
              },
            },
          },
        },
      },
    });

    if (!invite) {
      // 레거시 호환을 위한 이중 조회. 마이그레이션 완료 후 제거 예정.
      const legacyInvite = await this.prisma.pageInvite.findUnique({
        where: { tokenHash: token },
        include: {
          page: {
            select: {
              id: true,
              title: true,
              workspace: {
                select: {
                  id: true,
                  name: true,
                  linkInviteMode: true,
                },
              },
            },
          },
        },
      });
      invite = legacyInvite && !this.isSha256Hash(legacyInvite.tokenHash) ? legacyInvite : null;
    }

    if (!invite) {
      throw new NotFoundException('Page invite not found');
    }

    if (invite.expiresAt <= new Date()) {
      throw new BadRequestException('Page invite expired');
    }

    if (invite.acceptedAt) {
      throw new BadRequestException('Page invite already accepted');
    }

    return {
      pageId: invite.page.id,
      pageTitle: invite.page.title,
      workspaceId: invite.page.workspace.id,
      workspaceName: invite.page.workspace.name,
      role: invite.role,
      linkInviteMode: invite.page.workspace.linkInviteMode,
    };
  }

  async acceptInvite(user: Profile, dto: AcceptPageInviteDto) {
    const tokenHash = this.hashToken(dto.token);
    let invite = await this.prisma.pageInvite.findUnique({
      where: { tokenHash },
      include: {
        page: {
          select: {
            id: true,
            workspaceId: true,
          },
        },
      },
    });

    if (!invite) {
      // 레거시 호환을 위한 이중 조회. 마이그레이션 완료 후 제거 예정.
      const legacyInvite = await this.prisma.pageInvite.findUnique({
        where: { tokenHash: dto.token },
        include: {
          page: {
            select: {
              id: true,
              workspaceId: true,
            },
          },
        },
      });
      invite = legacyInvite && !this.isSha256Hash(legacyInvite.tokenHash) ? legacyInvite : null;
    }

    if (!invite) {
      throw new NotFoundException('Page invite not found');
    }

    if (invite.expiresAt <= new Date()) {
      throw new BadRequestException('Page invite expired');
    }

    const normalizedInviteEmail = this.normalizeEmail(invite.email);
    const normalizedUserEmail = this.normalizeEmail(user.email);
    const linkOnlyInvite = this.isLinkOnlyInviteEmail(normalizedInviteEmail);

    if (invite.acceptedAt) {
      throw new BadRequestException('Page invite already accepted');
    }

    // Email-based invites must be accepted by the same email account only.
    if (!linkOnlyInvite && normalizedInviteEmail !== normalizedUserEmail) {
      throw new ForbiddenException('Invite email does not match current account');
    }

    if (linkOnlyInvite) {
      const workspace = await this.prisma.workspace.findUnique({
        where: { id: invite.page.workspaceId },
        select: {
          linkInviteMode: true,
        },
      });

      if (!workspace) {
        throw new NotFoundException('Workspace not found');
      }

      if (workspace.linkInviteMode === LinkInviteMode.REQUEST) {
        const existingShare = await this.prisma.pageShare.findUnique({
          where: {
            pageId_userId: {
              pageId: invite.pageId,
              userId: user.id,
            },
          },
          select: {
            id: true,
          },
        });

        if (existingShare) {
          await this.prisma.pageInvite.update({
            where: { id: invite.id },
            data: {
              acceptedAt: new Date(),
              tokenHash: null,
            },
          });

          return {
            workspaceId: invite.page.workspaceId,
            pageId: invite.page.id,
            status: 'granted' as const,
          };
        }

        const request = await this.prisma.$transaction(async (tx) => {
          const nextRequest = await tx.pageAccessRequest.upsert({
            where: {
              pageId_userId: {
                pageId: invite.pageId,
                userId: user.id,
              },
            },
            create: {
              pageId: invite.pageId,
              userId: user.id,
              role: invite.role,
              status: PageAccessRequestStatus.PENDING,
            },
            update: {
              role: invite.role,
              status: PageAccessRequestStatus.PENDING,
              handledById: null,
              handledAt: null,
            },
          });

          await tx.pageInvite.update({
            where: { id: invite.id },
            data: {
              acceptedAt: new Date(),
              tokenHash: null,
            },
          });

          return nextRequest;
        });

        return {
          workspaceId: invite.page.workspaceId,
          pageId: invite.page.id,
          status: 'requested' as const,
          requestId: request.id,
        };
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.pageShare.upsert({
        where: {
          pageId_userId: {
            pageId: invite.pageId,
            userId: user.id,
          },
        },
        update: {
          role: invite.role,
        },
        create: {
          pageId: invite.pageId,
          userId: user.id,
          role: invite.role,
        },
      });

      await tx.pageInvite.update({
        where: { id: invite.id },
        data: {
          acceptedAt: new Date(),
          tokenHash: null,
        },
      });
    });

    this.invalidateAccess(invite.page.workspaceId, invite.pageId);
    return {
      workspaceId: invite.page.workspaceId,
      pageId: invite.page.id,
      status: 'granted' as const,
    };
  }
}
