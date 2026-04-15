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
import { randomBytes } from 'node:crypto';
import { RuntimeMetricsService } from '../../common/observability/runtime-metrics.service';
import { PrismaService } from '../../prisma/prisma.service';

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

@Injectable()
export class AiService {
  // 단일 노드 한정 in-memory 쿨다운 저장소.
  private readonly lastRequestAtByUser = new Map<string, number>();
  private readonly dailyRequestLimit: number;
  private readonly maxQuestionChars: number;
  private readonly requestCooldownMs: number;
  private readonly quotaTimezoneOffsetMinutes: number;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly metrics: RuntimeMetricsService,
  ) {
    this.dailyRequestLimit = this.readNumericConfig('AI_DAILY_REQUEST_LIMIT', 20, 1);
    this.maxQuestionChars = this.readNumericConfig('AI_MAX_QUESTION_CHARS', 2000, 100);
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
      const usage = await this.getUsage(userId);
      if (usage.remainingToday <= 0) {
        const { retryAfterSec } = this.getUsageWindow();
        this.throwQuotaExceeded(usage, retryAfterSec);
      }

      if (this.requestCooldownMs > 0) {
        const now = Date.now();
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

      const result = await this.generate(
        '너는 한국어 문서 협업 도구의 AI 도우미다. 사용자의 질문에 정확하고 실용적으로 답하라. 모르면 모른다고 말하라.',
        trimmedQuestion,
      );

      const nextUsage = await this.increaseUsage(userId);
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
