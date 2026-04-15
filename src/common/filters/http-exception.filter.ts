import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const isServerError = status >= 500;
    let message: unknown = 'Internal server error';
    let error: unknown;

    if (exception instanceof HttpException) {
      const exceptionResponse = exception.getResponse();
      if (typeof exceptionResponse === 'string') {
        message = exceptionResponse;
      } else if (
        typeof exceptionResponse === 'object' &&
        exceptionResponse !== null
      ) {
        const responseBody = exceptionResponse as {
          message?: unknown;
          error?: unknown;
        };

        if (responseBody.message !== undefined) {
          message = responseBody.message;
        }
        if (responseBody.error !== undefined) {
          error = responseBody.error;
        }
      }
    }

    if (isServerError) {
      message = 'Internal server error';
      this.logger.error(
        `HTTP ${status} ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : JSON.stringify(exception),
      );
    }

    const body: {
      statusCode: number;
      message: unknown;
      error?: unknown;
      path: string;
      timestamp: string;
    } = {
      statusCode: status,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    if (!isServerError && error !== undefined) {
      body.error = error;
    }

    response.status(status).json(body);
  }
}
