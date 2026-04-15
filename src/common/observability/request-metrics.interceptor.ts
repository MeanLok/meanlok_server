import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { tap } from 'rxjs/operators';
import { RuntimeMetricsService } from './runtime-metrics.service';

@Injectable()
export class RequestMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: RuntimeMetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler) {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<
      {
        method?: string;
        baseUrl?: string;
        route?: { path?: string };
        originalUrl?: string;
        path?: string;
      }
    >();
    const response = httpContext.getResponse<{ statusCode?: number }>();
    const startedAt = Date.now();
    const method = request.method ?? 'GET';
    const route = this.normalizeRoute(request);

    let captured = false;
    const capture = (statusCode: number) => {
      if (captured) {
        return;
      }

      captured = true;
      this.metrics.recordHttp({
        method,
        route,
        statusCode,
        durationMs: Date.now() - startedAt,
      });
    };

    return next.handle().pipe(
      tap({
        next: () => {
          capture(response.statusCode ?? 200);
        },
        error: (error: unknown) => {
          const statusCode =
            typeof error === 'object' &&
            error !== null &&
            'status' in error &&
            typeof (error as { status?: unknown }).status === 'number'
              ? ((error as { status: number }).status ?? 500)
              : response.statusCode ?? 500;

          capture(statusCode);
        },
      }),
    );
  }

  private normalizeRoute(request: {
    baseUrl?: string;
    route?: { path?: string };
    originalUrl?: string;
    path?: string;
  }) {
    const raw = [request.baseUrl ?? '', request.route?.path ?? request.path ?? request.originalUrl ?? '']
      .join('')
      .replace(/\/+/g, '/');

    return raw
      .replace(/[0-9a-f]{24,}/gi, ':id')
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ':uuid')
      .replace(/\/\d+/g, '/:num');
  }
}
