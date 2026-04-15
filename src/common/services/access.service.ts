import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PageRole, Role } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RuntimeCacheService } from '../runtime-cache/runtime-cache.service';

export type EffectivePageRole = 'EDITOR' | 'VIEWER' | null;

export interface EffectivePageAccess {
  role: EffectivePageRole;
  viaMember: boolean;
  workspaceId: string;
}

const PAGE_ROLE_PRIORITY: Record<'EDITOR' | 'VIEWER', number> = {
  EDITOR: 2,
  VIEWER: 1,
};

const WORKSPACE_TO_PAGE_ROLE: Record<Role, EffectivePageRole> = {
  OWNER: 'EDITOR',
  EDITOR: 'EDITOR',
  VIEWER: 'VIEWER',
};

function toPriority(role: EffectivePageRole): number {
  if (!role) {
    return 0;
  }

  return PAGE_ROLE_PRIORITY[role];
}

function maxRole(a: EffectivePageRole, b: EffectivePageRole): EffectivePageRole {
  return toPriority(a) >= toPriority(b) ? a : b;
}

@Injectable()
export class AccessService {
  private readonly accessCacheTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly runtimeCache: RuntimeCacheService,
  ) {
    const configured = Number(this.configService.get('ACCESS_CACHE_TTL_MS') ?? 5_000);
    this.accessCacheTtlMs = Number.isFinite(configured)
      ? Math.max(250, Math.trunc(configured))
      : 5_000;
  }

  private async listAncestorPageIds(pageId: string): Promise<string[]> {
    const pageRevision = this.runtimeCache.getPageRevision(pageId);
    const cacheKey = [
      'access:ancestor-ids',
      `:p:${pageId}:`,
      `rev:${pageRevision}`,
    ].join(':');

    return this.runtimeCache.getOrSet(
      cacheKey,
      async () => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
          WITH RECURSIVE ancestors AS (
            SELECT id, "parentId"
            FROM "Page"
            WHERE id = ${pageId}
            UNION ALL
            SELECT p.id, p."parentId"
            FROM "Page" p
            INNER JOIN ancestors a ON a."parentId" = p.id
          )
          SELECT id
          FROM ancestors
        `;

        return rows.map((row) => row.id);
      },
      this.accessCacheTtlMs,
    );
  }

  async getWorkspaceMemberRole(userId: string, workspaceId: string): Promise<Role | null> {
    const workspaceRevision = this.runtimeCache.getWorkspaceRevision(workspaceId);
    const cacheKey = [
      'access:workspace-member-role',
      `:ws:${workspaceId}:`,
      `rev:${workspaceRevision}`,
      `u:${userId}`,
    ].join(':');

    return this.runtimeCache.getOrSet(
      cacheKey,
      async () => {
        const membership = await this.prisma.workspaceMember.findUnique({
          where: {
            userId_workspaceId: {
              userId,
              workspaceId,
            },
          },
          select: {
            role: true,
          },
        });

        return membership?.role ?? null;
      },
      this.accessCacheTtlMs,
    );
  }

  async getEffectivePageRole(
    userId: string,
    pageId: string,
  ): Promise<EffectivePageAccess> {
    const page = await this.prisma.page.findUnique({
      where: { id: pageId },
      select: {
        id: true,
        workspaceId: true,
      },
    });

    if (!page) {
      throw new NotFoundException('Page not found');
    }
    const workspaceRevision = this.runtimeCache.getWorkspaceRevision(page.workspaceId);
    const pageRevision = this.runtimeCache.getPageRevision(page.id);
    const cacheKey = [
      'access:effective-role',
      `:ws:${page.workspaceId}:`,
      `wrev:${workspaceRevision}`,
      `:p:${page.id}:`,
      `prev:${pageRevision}`,
      `u:${userId}`,
    ].join(':');

    return this.runtimeCache.getOrSet(
      cacheKey,
      async () => {
        const ancestorIds = await this.listAncestorPageIds(page.id);

        const pageShares = await this.prisma.pageShare.findMany({
          where: {
            userId,
            pageId: {
              in: ancestorIds,
            },
          },
          select: {
            role: true,
          },
        });

        const pageRole = pageShares.reduce<EffectivePageRole>((acc, share) => {
          const current = share.role as PageRole;
          const nextRole: EffectivePageRole = current === PageRole.EDITOR ? 'EDITOR' : 'VIEWER';
          return maxRole(acc, nextRole);
        }, null);

        const workspaceMemberRole = await this.getWorkspaceMemberRole(userId, page.workspaceId);
        const workspaceRole = workspaceMemberRole
          ? WORKSPACE_TO_PAGE_ROLE[workspaceMemberRole]
          : null;

        const role = maxRole(workspaceRole, pageRole);

        return {
          role,
          viaMember: toPriority(workspaceRole) >= toPriority(pageRole) && Boolean(workspaceRole),
          workspaceId: page.workspaceId,
        };
      },
      this.accessCacheTtlMs,
    );
  }

  async assertPageAccess(
    userId: string,
    pageId: string,
    required: 'VIEWER' | 'EDITOR',
  ): Promise<EffectivePageAccess> {
    const effective = await this.getEffectivePageRole(userId, pageId);

    if (toPriority(effective.role) < PAGE_ROLE_PRIORITY[required]) {
      throw new ForbiddenException('Insufficient page access');
    }

    return effective;
  }

  async isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
    const role = await this.getWorkspaceMemberRole(userId, workspaceId);
    return role !== null;
  }

  async listAccessibleRootPageIds(userId: string, workspaceId: string): Promise<string[]> {
    const workspaceRevision = this.runtimeCache.getWorkspaceRevision(workspaceId);
    const cacheKey = [
      'access:root-pages',
      `:ws:${workspaceId}:`,
      `rev:${workspaceRevision}`,
      `u:${userId}`,
    ].join(':');

    return this.runtimeCache.getOrSet(
      cacheKey,
      async () => {
        const shares = await this.prisma.pageShare.findMany({
          where: {
            userId,
            page: {
              workspaceId,
            },
          },
          select: {
            pageId: true,
          },
        });

        return shares.map((share) => share.pageId);
      },
      this.accessCacheTtlMs,
    );
  }
}
