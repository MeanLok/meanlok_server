import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

@Injectable()
export class RuntimeCacheService {
  private readonly store = new Map<string, CacheEntry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly workspaceRevision = new Map<string, number>();
  private readonly pageRevision = new Map<string, number>();
  private readonly defaultTtlMs: number;

  constructor(private readonly configService: ConfigService) {
    const rawTtl = Number(this.configService.get('ACCESS_CACHE_TTL_MS') ?? 5_000);
    this.defaultTtlMs = Number.isFinite(rawTtl) ? Math.max(250, Math.trunc(rawTtl)) : 5_000;
  }

  getWorkspaceRevision(workspaceId: string) {
    return this.workspaceRevision.get(workspaceId) ?? 0;
  }

  getPageRevision(pageId: string) {
    return this.pageRevision.get(pageId) ?? 0;
  }

  invalidateWorkspace(workspaceId: string) {
    this.workspaceRevision.set(workspaceId, this.getWorkspaceRevision(workspaceId) + 1);
    this.deleteByToken(`:ws:${workspaceId}:`);
  }

  invalidatePage(pageId: string) {
    this.pageRevision.set(pageId, this.getPageRevision(pageId) + 1);
    this.deleteByToken(`:p:${pageId}:`);
  }

  async getOrSet<T>(
    key: string,
    loader: () => Promise<T>,
    ttlMs = this.defaultTtlMs,
  ): Promise<T> {
    const now = Date.now();
    const cached = this.store.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.value as T;
    }

    const running = this.inflight.get(key);
    if (running) {
      return running as Promise<T>;
    }

    const task = loader()
      .then((value) => {
        this.store.set(key, {
          value,
          expiresAt: Date.now() + Math.max(100, ttlMs),
        });
        this.pruneExpired();
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, task as Promise<unknown>);
    return task;
  }

  private deleteByToken(token: string) {
    for (const key of this.store.keys()) {
      if (key.includes(token)) {
        this.store.delete(key);
      }
    }

    for (const key of this.inflight.keys()) {
      if (key.includes(token)) {
        this.inflight.delete(key);
      }
    }
  }

  private pruneExpired() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }
}
