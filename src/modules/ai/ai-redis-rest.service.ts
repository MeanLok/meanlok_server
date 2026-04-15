import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface RedisRestResponse {
  result?: unknown;
}

@Injectable()
export class AiRedisRestService {
  private readonly restUrl: string | null;
  private readonly restToken: string | null;

  constructor(private readonly configService: ConfigService) {
    this.restUrl =
      this.configService.get<string>('AI_REDIS_REST_URL')?.trim().replace(/\/$/, '') ??
      null;
    this.restToken = this.configService.get<string>('AI_REDIS_REST_TOKEN')?.trim() ?? null;
  }

  isEnabled() {
    return Boolean(this.restUrl && this.restToken);
  }

  private async command(parts: Array<string | number>) {
    if (!this.restUrl || !this.restToken) {
      return null;
    }

    const commandPath = parts.map((part) => encodeURIComponent(String(part))).join('/');

    try {
      const response = await fetch(`${this.restUrl}/${commandPath}`, {
        headers: {
          Authorization: `Bearer ${this.restToken}`,
        },
        cache: 'no-store',
      });
      if (!response.ok) {
        return null;
      }

      const payload = (await response.json().catch(() => null)) as RedisRestResponse | null;
      return payload?.result ?? null;
    } catch {
      return null;
    }
  }

  async get(key: string) {
    const value = await this.command(['get', key]);
    return typeof value === 'string' ? value : null;
  }

  async setEx(key: string, value: string, ttlSec: number) {
    if (ttlSec <= 0) {
      return;
    }
    await this.command(['set', key, value, 'EX', ttlSec]);
  }

  async setNxEx(key: string, value: string, ttlSec: number) {
    if (ttlSec <= 0) {
      return true;
    }
    const result = await this.command(['set', key, value, 'NX', 'EX', ttlSec]);
    return result === 'OK';
  }

  async incr(key: string) {
    const value = await this.command(['incr', key]);
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  async expire(key: string, ttlSec: number) {
    if (ttlSec <= 0) {
      return;
    }
    await this.command(['expire', key, ttlSec]);
  }

  async ttl(key: string) {
    const value = await this.command(['ttl', key]);
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return numeric;
  }
}
