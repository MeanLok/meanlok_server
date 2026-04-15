import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { RuntimeMetricsService } from '../../common/observability/runtime-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AiRedisRestService } from './ai-redis-rest.service';

const DAY_MS = 24 * 60 * 60 * 1000;

interface GroqChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
    };
  }>;
  error?: {
    message?: string;
  };
}

export interface AiUsageSummary {
  usedToday: number;
  dailyLimit: number;
  remainingToday: number;
  resetAt: string;
}

interface CachedAnswer {
  result: string;
  expiresAt: number;
}

@Injectable()
export class AiService {
  // Redis 미설정 시 단일 노드 fallback 저장소.
  private readonly lastRequestAtByUser = new Map<string, number>();
  private readonly localRequestCountByWindow = new Map<string, number>();
  private readonly cachedAnswerByUserQuestion = new Map<string, CachedAnswer>();
  private readonly dailyRequestLimit: number;
  private readonly maxQuestionChars: number;
  private readonly maxResponseTokens: number;
  private readonly questionCacheTtlMs: number;
  private readonly estimatedTokensPerRequest: number;
  private readonly dailyEstimatedTokenBudget: number;
  private readonly rateLimitWindowSec: number;
  private readonly rateLimitMaxRequests: number;
  private readonly requestCooldownMs: number;
  private readonly quotaTimezoneOffsetMinutes: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metrics: RuntimeMetricsService,
    private readonly redis: AiRedisRestService,
  ) {
    this.dailyRequestLimit = this.readNumericConfig('AI_DAILY_REQUEST_LIMIT', 20, 1);
    this.maxQuestionChars = this.readNumericConfig('AI_MAX_QUESTION_CHARS', 2000, 100);
    this.maxResponseTokens = this.readNumericConfig('AI_MAX_RESPONSE_TOKENS', 512, 64, 4096);
    this.questionCacheTtlMs =
      this.readNumericConfig('AI_QUESTION_CACHE_TTL_SEC', 30, 0, 600) * 1000;
    this.estimatedTokensPerRequest = this.readNumericConfig(
      'AI_ESTIMATED_TOKENS_PER_REQUEST',
      700,
      50,
      8000,
    );
    this.dailyEstimatedTokenBudget = this.readNumericConfig(
      'AI_DAILY_TOKEN_BUDGET',
      20_000,
      0,
      5_000_000,
    );
    this.rateLimitWindowSec = this.readNumericConfig(
      'AI_RATE_LIMIT_WINDOW_SEC',
      60,
      1,
      3_600,
    );
    this.rateLimitMaxRequests = this.readNumericConfig(
      'AI_RATE_LIMIT_MAX_REQUESTS',
      10,
      1,
      10_000,
    );
    this.requestCooldownMs =
      this.readNumericConfig('AI_REQUEST_COOLDOWN_SEC', 12, 0) * 1000;
    this.quotaTimezoneOffsetMinutes = this.readNumericConfig(
      'AI_RESET_TIMEZONE_OFFSET_MINUTES',
      540,
      -720,
      840,
    );
  }

  private readNumericConfig(
    key: string,
    fallback: number,
    min?: number,
    max?: number,
  ) {
    const rawValue = this.configService.get<string | number>(key);
    const parsed = Number(rawValue);

    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    let value = Math.trunc(parsed);
    if (min !== undefined && value < min) {
      value = min;
    }
    if (max !== undefined && value > max) {
      value = max;
    }

    return value;
  }

  private getUsageWindow(nowMs = Date.now()) {
    const offsetMs = this.quotaTimezoneOffsetMinutes * 60_000;
    const shiftedMs = nowMs + offsetMs;
    const dayStartShiftedMs = Math.floor(shiftedMs / DAY_MS) * DAY_MS;
    const nextDayShiftedMs = dayStartShiftedMs + DAY_MS;
    const dayStart = new Date(dayStartShiftedMs);

    const dateKey = [
      dayStart.getUTCFullYear(),
      String(dayStart.getUTCMonth() + 1).padStart(2, '0'),
      String(dayStart.getUTCDate()).padStart(2, '0'),
    ].join('-');

    const resetAt = new Date(nextDayShiftedMs - offsetMs).toISOString();
    const retryAfterSec = Math.max(
      1,
      Math.ceil((nextDayShiftedMs - shiftedMs) / 1000),
    );

    return { dateKey, resetAt, retryAfterSec };
  }

  private buildUsageSummary(usedToday: number, resetAt: string): AiUsageSummary {
    return {
      usedToday,
      dailyLimit: this.dailyRequestLimit,
      remainingToday: Math.max(0, this.dailyRequestLimit - usedToday),
      resetAt,
    };
  }

  private normalizeQuestionForCache(question: string) {
    return question.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  private questionCacheKey(userId: string, question: string) {
    const normalized = this.normalizeQuestionForCache(question);
    const hash = createHash('sha1').update(normalized).digest('hex');
    return `ai:answer:${userId}:${hash}`;
  }

  private windowRateLimitKey(userId: string, nowMs: number) {
    const windowId = Math.floor(nowMs / (this.rateLimitWindowSec * 1000));
    return `ai:ratelimit:${userId}:${windowId}`;
  }

  private cooldownKey(userId: string) {
    return `ai:cooldown:${userId}`;
  }

  private pruneInMemoryState(now = Date.now()) {
    for (const [key, value] of this.cachedAnswerByUserQuestion.entries()) {
      if (value.expiresAt <= now) {
        this.cachedAnswerByUserQuestion.delete(key);
      }
    }

    if (this.requestCooldownMs <= 0) {
      this.lastRequestAtByUser.clear();
      return;
    }

    const staleThreshold = now - Math.max(this.requestCooldownMs * 5, 60_000);
    for (const [key, lastRequestAt] of this.lastRequestAtByUser.entries()) {
      if (lastRequestAt < staleThreshold) {
        this.lastRequestAtByUser.delete(key);
      }
    }

    const windowRetentionMs = Math.max(this.rateLimitWindowSec * 3 * 1000, 120_000);
    for (const key of this.localRequestCountByWindow.keys()) {
      const keyParts = key.split(':');
      const windowIdRaw = keyParts[keyParts.length - 1];
      const windowId = Number(windowIdRaw);
      if (!Number.isFinite(windowId)) {
        this.localRequestCountByWindow.delete(key);
        continue;
      }

      const windowStartMs = windowId * this.rateLimitWindowSec * 1000;
      if (windowStartMs + windowRetentionMs < now) {
        this.localRequestCountByWindow.delete(key);
      }
    }
  }

  private async getCachedAnswer(userId: string, question: string) {
    if (this.questionCacheTtlMs <= 0) {
      return null;
    }

    const cacheKey = this.questionCacheKey(userId, question);
    if (this.redis.isEnabled()) {
      const cachedValue = await this.redis.get(cacheKey);
      if (typeof cachedValue === 'string' && cachedValue) {
        return cachedValue;
      }
    }

    this.pruneInMemoryState();
    const cached = this.cachedAnswerByUserQuestion.get(cacheKey);
    if (!cached || cached.expiresAt <= Date.now()) {
      if (cached) {
        this.cachedAnswerByUserQuestion.delete(cacheKey);
      }
      return null;
    }

    return cached.result;
  }

  private async setCachedAnswer(userId: string, question: string, result: string) {
    if (this.questionCacheTtlMs <= 0 || !result) {
      return;
    }

    const cacheKey = this.questionCacheKey(userId, question);
    if (this.redis.isEnabled()) {
      await this.redis.setEx(cacheKey, result, Math.ceil(this.questionCacheTtlMs / 1000));
    }

    const now = Date.now();
    this.pruneInMemoryState(now);
    this.cachedAnswerByUserQuestion.set(cacheKey, {
      result,
      expiresAt: now + this.questionCacheTtlMs,
    });
  }

  async getUsage(userId: string): Promise<AiUsageSummary> {
    const { dateKey, resetAt } = this.getUsageWindow();
    const usageRow = await this.prisma.aiDailyUsage.findUnique({
      where: {
        userId_dateKey: {
          userId,
          dateKey,
        },
      },
      select: {
        usedCount: true,
      },
    });
    const usedToday = usageRow?.usedCount ?? 0;

    return this.buildUsageSummary(usedToday, resetAt);
  }

  private async increaseUsage(userId: string): Promise<AiUsageSummary> {
    const { dateKey, resetAt, retryAfterSec } = this.getUsageWindow();
    const usageRows = await this.prisma.$queryRaw<
      Array<{ incrementedCount: number | null; currentCount: number }>
    >`
      WITH ensure_row AS (
        INSERT INTO "AiDailyUsage" (
          "id",
          "userId",
          "dateKey",
          "usedCount",
          "createdAt",
          "updatedAt"
        )
        VALUES (
          ${randomBytes(16).toString('hex')},
          ${userId},
          ${dateKey},
          0,
          NOW(),
          NOW()
        )
        ON CONFLICT ("userId", "dateKey") DO NOTHING
      ),
      incremented AS (
        UPDATE "AiDailyUsage"
        SET
          "usedCount" = "usedCount" + 1,
          "updatedAt" = NOW()
        WHERE
          "userId" = ${userId}
          AND "dateKey" = ${dateKey}
          AND "usedCount" < ${this.dailyRequestLimit}
        RETURNING "usedCount"
      ),
      current_usage AS (
        SELECT "usedCount"
        FROM "AiDailyUsage"
        WHERE "userId" = ${userId}
          AND "dateKey" = ${dateKey}
      )
      SELECT
        (SELECT "usedCount" FROM incremented LIMIT 1) AS "incrementedCount",
        COALESCE((SELECT "usedCount" FROM current_usage LIMIT 1), 0) AS "currentCount"
    `;

    const incrementedCount = usageRows[0]?.incrementedCount;
    const currentCount = Number(usageRows[0]?.currentCount ?? 0);

    if (incrementedCount === null) {
      const usage = this.buildUsageSummary(currentCount, resetAt);
      this.throwQuotaExceeded(usage, retryAfterSec);
    }

    const usedToday = Number(incrementedCount ?? currentCount);
    if (!Number.isFinite(usedToday) || usedToday <= 0) {
      const usage = this.buildUsageSummary(usedToday, resetAt);
      this.throwQuotaExceeded(usage, retryAfterSec);
    }

    return this.buildUsageSummary(usedToday, resetAt);
  }

  private getGroqConfig() {
    const apiKey = this.configService.get<string>('GROQ_API_KEY')?.trim();
    const model =
      this.configService.get<string>('GROQ_MODEL')?.trim() ||
      'llama-3.1-8b-instant';
    const baseUrl =
      this.configService.get<string>('GROQ_BASE_URL')?.trim() ||
      'https://api.groq.com/openai/v1';

    if (!apiKey) {
      throw new ServiceUnavailableException(
        'GROQ_API_KEY is not configured',
      );
    }

    return { apiKey, model, baseUrl };
  }

  private extractContent(payload: GroqChatCompletionResponse) {
    const content = payload.choices?.[0]?.message?.content;

    if (typeof content !== 'string') {
      return '';
    }

    return content.trim();
  }

  private getRetryAfterSeconds(retryAfterHeader: string | null) {
    if (!retryAfterHeader) {
      return undefined;
    }

    const numericSeconds = Number(retryAfterHeader);
    if (Number.isFinite(numericSeconds) && numericSeconds > 0) {
      return Math.ceil(numericSeconds);
    }

    const retryAtMs = Date.parse(retryAfterHeader);
    if (Number.isFinite(retryAtMs)) {
      const diffSec = Math.ceil((retryAtMs - Date.now()) / 1000);
      return diffSec > 0 ? diffSec : undefined;
    }

    return undefined;
  }

  private throwQuotaExceeded(usage: AiUsageSummary, retryAfterSec: number): never {
    throw new HttpException(
      {
        message: '오늘 AI 사용량을 다 썼어요. 내일 다시 시도해 주세요.',
        error: {
          code: 'QUOTA_EXCEEDED',
          usedToday: usage.usedToday,
          dailyLimit: usage.dailyLimit,
          remainingToday: usage.remainingToday,
          resetAt: usage.resetAt,
          retryAfterSec,
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private throwRateLimited(retryAfterSec: number): never {
    throw new HttpException(
      {
        message: '요청이 너무 빨라요. 잠시 후 다시 시도해 주세요.',
        error: {
          code: 'RATE_LIMITED',
          retryAfterSec,
          cooldownSec: Math.ceil(this.requestCooldownMs / 1000),
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private async enforceRateLimit(userId: string) {
    const now = Date.now();
    this.pruneInMemoryState(now);

    if (this.redis.isEnabled()) {
      const key = this.windowRateLimitKey(userId, now);
      const count = await this.redis.incr(key);
      if (count !== null) {
        if (count === 1) {
          await this.redis.expire(key, this.rateLimitWindowSec + 1);
        }

        if (count > this.rateLimitMaxRequests) {
          const ttlSec = await this.redis.ttl(key);
          this.throwRateLimited(ttlSec ?? this.rateLimitWindowSec);
        }
        return;
      }
    }

    const localKey = this.windowRateLimitKey(userId, now);
    const nextCount = (this.localRequestCountByWindow.get(localKey) ?? 0) + 1;
    this.localRequestCountByWindow.set(localKey, nextCount);
    if (nextCount > this.rateLimitMaxRequests) {
      this.throwRateLimited(this.rateLimitWindowSec);
    }
  }

  private async enforceCooldown(userId: string) {
    if (this.requestCooldownMs <= 0) {
      return;
    }

    const now = Date.now();
    const cooldownSec = Math.max(1, Math.ceil(this.requestCooldownMs / 1000));

    if (this.redis.isEnabled()) {
      const key = this.cooldownKey(userId);
      const locked = await this.redis.setNxEx(key, String(now), cooldownSec);
      if (!locked) {
        const ttlSec = await this.redis.ttl(key);
        this.throwRateLimited(ttlSec ?? cooldownSec);
      }
      return;
    }

    const lastRequestAt = this.lastRequestAtByUser.get(userId);
    if (lastRequestAt) {
      const elapsedMs = now - lastRequestAt;
      if (elapsedMs < this.requestCooldownMs) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((this.requestCooldownMs - elapsedMs) / 1000),
        );
        this.throwRateLimited(retryAfterSec);
      }
    }

    this.lastRequestAtByUser.set(userId, now);
  }

  private exceedsDailyTokenBudget(usedToday: number) {
    if (this.dailyEstimatedTokenBudget <= 0) {
      return false;
    }

    const estimatedUsedTokens = usedToday * this.estimatedTokensPerRequest;
    return estimatedUsedTokens >= this.dailyEstimatedTokenBudget;
  }

  private extractErrorCode(error: unknown): string | null {
    if (!(error instanceof HttpException)) {
      return 'UNKNOWN';
    }

    const response = error.getResponse();
    if (typeof response === 'object' && response !== null && 'error' in response) {
      const nestedError = (response as { error?: { code?: unknown } }).error;
      if (
        nestedError &&
        typeof nestedError === 'object' &&
        'code' in nestedError &&
        typeof nestedError.code === 'string'
      ) {
        return nestedError.code;
      }
    }

    return error.name ?? 'HTTP_EXCEPTION';
  }

  private validateQuestion(question: string) {
    const trimmedQuestion = question.trim();

    if (trimmedQuestion.length > this.maxQuestionChars) {
      throw new BadRequestException({
        message: `질문은 최대 ${this.maxQuestionChars}자까지 입력할 수 있어요.`,
        error: {
          code: 'INPUT_TOO_LONG',
          maxChars: this.maxQuestionChars,
          currentChars: trimmedQuestion.length,
        },
      });
    }

    return trimmedQuestion;
  }

  private throwUpstreamError(
    response: Response,
    payload: GroqChatCompletionResponse,
  ): never {
    const upstreamMessage =
      payload.error?.message || `Groq request failed (${response.status})`;

    if (response.status === 429) {
      const retryAfterSec =
        this.getRetryAfterSeconds(response.headers.get('retry-after')) ?? 15;
      const looksLikeQuotaError = /quota|credit|insufficient/i.test(
        upstreamMessage,
      );

      if (looksLikeQuotaError) {
        throw new HttpException(
          {
            message: 'AI 제공자 사용량 한도를 초과했어요. 잠시 후 다시 시도해 주세요.',
            error: {
              code: 'QUOTA_EXCEEDED',
              retryAfterSec,
              upstreamMessage,
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new HttpException(
        {
          message: 'AI 요청이 많아요. 잠시 후 다시 시도해 주세요.',
          error: {
            code: 'RATE_LIMITED',
            retryAfterSec,
            upstreamMessage,
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ServiceUnavailableException({
        message: 'AI 서비스 인증 설정을 확인해 주세요.',
        error: {
          code: 'AI_PROVIDER_AUTH_FAILED',
          upstreamMessage,
        },
      });
    }

    if (response.status === 408 || response.status === 504) {
      throw new GatewayTimeoutException({
        message: 'AI 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.',
        error: {
          code: 'TIMEOUT',
          upstreamMessage,
        },
      });
    }

    throw new BadGatewayException({
      message: 'AI 서비스에 일시적인 오류가 있어요. 잠시 후 다시 시도해 주세요.',
      error: {
        code: 'SERVER_ERROR',
        upstreamMessage,
      },
    });
  }

  private async generate(systemPrompt: string, userPrompt: string) {
    if (!userPrompt.trim()) {
      return '';
    }

    const { apiKey, model, baseUrl } = this.getGroqConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          max_tokens: this.maxResponseTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      const payload =
        (await response.json().catch(() => ({}))) as GroqChatCompletionResponse;

      if (!response.ok) {
        this.throwUpstreamError(response, payload);
      }

      return this.extractContent(payload);
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      const isAbortError =
        typeof error === 'object' &&
        error !== null &&
        'name' in error &&
        (error as { name?: string }).name === 'AbortError';

      if (isAbortError) {
        throw new GatewayTimeoutException({
          message: 'AI 응답이 지연되고 있어요. 잠시 후 다시 시도해 주세요.',
          error: { code: 'TIMEOUT' },
        });
      }

      throw new BadGatewayException({
        message: 'AI 서버와 통신 중 오류가 발생했어요.',
        error: { code: 'NETWORK' },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async ask(userId: string, question: string) {
    const startedAt = Date.now();
    let success = false;
    let errorCode: string | null = null;

    const trimmedQuestion = this.validateQuestion(question);
    if (!trimmedQuestion) {
      try {
        const response = {
          result: '',
          usage: await this.getUsage(userId),
        };
        success = true;
        return response;
      } finally {
        this.metrics.recordAiRequest({
          durationMs: Date.now() - startedAt,
          success,
          errorCode,
        });
      }
    }

    try {
      const cachedResult = await this.getCachedAnswer(userId, trimmedQuestion);
      if (cachedResult) {
        const usage = await this.getUsage(userId);
        success = true;
        return {
          result: cachedResult,
          usage,
        };
      }

      const usage = await this.getUsage(userId);
      if (usage.remainingToday <= 0) {
        const { retryAfterSec } = this.getUsageWindow();
        this.throwQuotaExceeded(usage, retryAfterSec);
      }

      if (this.exceedsDailyTokenBudget(usage.usedToday)) {
        const { retryAfterSec } = this.getUsageWindow();
        this.throwQuotaExceeded(usage, retryAfterSec);
      }

      await this.enforceRateLimit(userId);
      await this.enforceCooldown(userId);

      const result = await this.generate(
        '너는 한국어 문서 협업 도구의 AI 도우미다. 사용자의 질문에 정확하고 실용적으로 답하라. 모르면 모른다고 말하라.',
        trimmedQuestion,
      );

      const nextUsage = await this.increaseUsage(userId);
      await this.setCachedAnswer(userId, trimmedQuestion, result);
      success = true;

      return {
        result,
        usage: nextUsage,
      };
    } catch (error) {
      errorCode = this.extractErrorCode(error);
      throw error;
    } finally {
      this.metrics.recordAiRequest({
        durationMs: Date.now() - startedAt,
        success,
        errorCode,
      });
    }
  }
}
