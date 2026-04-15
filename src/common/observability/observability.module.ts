import { Global, Module } from '@nestjs/common';
import { RequestMetricsInterceptor } from './request-metrics.interceptor';
import { RuntimeMetricsService } from './runtime-metrics.service';

@Global()
@Module({
  providers: [RuntimeMetricsService, RequestMetricsInterceptor],
  exports: [RuntimeMetricsService, RequestMetricsInterceptor],
})
export class ObservabilityModule {}
