import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface HttpMetricEvent {
  at: number;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

interface SaveMetricEvent {
  at: number;
  durationMs: number;
  success: boolean;
}

interface AiMetricEvent {
  at: number;
  durationMs: number;
  success: boolean;
  errorCode: string | null;
}

function percentile(values: number[], target: number) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((target / 100) * sorted.length) - 1),
  );
  return Number(sorted[index]?.toFixed(2) ?? 0);
}

function ratio(numerator: number, denominator: number) {
  if (denominator === 0) {
    return 0;
  }

  return Number(((numerator / denominator) * 100).toFixed(2));
}

@Injectable()
export class RuntimeMetricsService {
  private readonly startedAt = Date.now();
  private readonly windowMs: number;
  private readonly httpEvents: HttpMetricEvent[] = [];
  private readonly documentSaveEvents: SaveMetricEvent[] = [];
  private readonly aiEvents: AiMetricEvent[] = [];

  constructor(private readonly configService: ConfigService) {
    const rawWindowMinutes = Number(this.configService.get('METRICS_WINDOW_MINUTES') ?? 60);
    const windowMinutes = Number.isFinite(rawWindowMinutes)
      ? Math.max(5, Math.trunc(rawWindowMinutes))
      : 60;

    this.windowMs = windowMinutes * 60_000;
  }

  recordHttp(event: Omit<HttpMetricEvent, 'at'>) {
    this.httpEvents.push({
      at: Date.now(),
      ...event,
    });
    this.prune();
  }

  recordDocumentSave(event: Omit<SaveMetricEvent, 'at'>) {
    this.documentSaveEvents.push({
      at: Date.now(),
      ...event,
    });
    this.prune();
  }

  recordAiRequest(event: Omit<AiMetricEvent, 'at'>) {
    this.aiEvents.push({
      at: Date.now(),
      ...event,
    });
    this.prune();
  }

  snapshot() {
    this.prune();

    const httpDurations = this.httpEvents.map((event) => event.durationMs);
    const groupedHttp = new Map<
      string,
      { count: number; durations: number[]; errors: number }
    >();
    for (const event of this.httpEvents) {
      const key = `${event.method} ${event.route}`;
      const current = groupedHttp.get(key) ?? { count: 0, durations: [], errors: 0 };
      current.count += 1;
      current.durations.push(event.durationMs);
      if (event.statusCode >= 500) {
        current.errors += 1;
      }
      groupedHttp.set(key, current);
    }

    const routeStats = [...groupedHttp.entries()]
      .map(([route, stats]) => ({
        route,
        count: stats.count,
        p95Ms: percentile(stats.durations, 95),
        errorRatePct: ratio(stats.errors, stats.count),
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);

    const failedSaves = this.documentSaveEvents.filter((event) => !event.success).length;
    const aiErrors = this.aiEvents.filter((event) => !event.success).length;
    const aiErrorCodeCounts = new Map<string, number>();
    for (const event of this.aiEvents) {
      if (!event.success) {
        const key = event.errorCode ?? 'UNKNOWN';
        aiErrorCodeCounts.set(key, (aiErrorCodeCounts.get(key) ?? 0) + 1);
      }
    }

    return {
      generatedAt: new Date().toISOString(),
      windowMinutes: Math.round(this.windowMs / 60_000),
      uptimeSec: Math.round((Date.now() - this.startedAt) / 1000),
      http: {
        total: this.httpEvents.length,
        p95Ms: percentile(httpDurations, 95),
        routes: routeStats,
      },
      documentSaves: {
        total: this.documentSaveEvents.length,
        failed: failedSaves,
        failureRatePct: ratio(failedSaves, this.documentSaveEvents.length),
        p95Ms: percentile(
          this.documentSaveEvents.map((event) => event.durationMs),
          95,
        ),
      },
      ai: {
        total: this.aiEvents.length,
        failed: aiErrors,
        errorRatePct: ratio(aiErrors, this.aiEvents.length),
        p95Ms: percentile(
          this.aiEvents.map((event) => event.durationMs),
          95,
        ),
        errorsByCode: [...aiErrorCodeCounts.entries()]
          .map(([code, count]) => ({ code, count }))
          .sort((a, b) => b.count - a.count),
      },
    };
  }

  private prune() {
    const threshold = Date.now() - this.windowMs;
    this.pruneEvents(this.httpEvents, threshold);
    this.pruneEvents(this.documentSaveEvents, threshold);
    this.pruneEvents(this.aiEvents, threshold);
  }

  private pruneEvents<T extends { at: number }>(events: T[], threshold: number) {
    let deleteUntil = 0;
    while (deleteUntil < events.length && events[deleteUntil]!.at < threshold) {
      deleteUntil += 1;
    }

    if (deleteUntil > 0) {
      events.splice(0, deleteUntil);
    }
  }
}
