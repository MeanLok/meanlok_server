import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RequestMetricsInterceptor } from './common/observability/request-metrics.interceptor';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(json({ limit: '1mb' }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(app.get(RequestMetricsInterceptor));
  app.use(
    compression({
      threshold: Number(config.get('COMPRESSION_THRESHOLD_BYTES') ?? 1024),
    }),
  );
  app.enableCors({
    origin: config.get<string>('CORS_ORIGIN')!,
    credentials: true,
  });

  await app.listen(config.get<number>('PORT') ?? 3001);
}
bootstrap();
