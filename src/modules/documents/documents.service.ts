import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocFormat, type Profile } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { RuntimeMetricsService } from '../../common/observability/runtime-metrics.service';
import { RuntimeCacheService } from '../../common/runtime-cache/runtime-cache.service';
import { AccessService } from '../../common/services/access.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SanitizeService } from '../../shared/sanitize/sanitize.service';
import { UpsertDocumentDto } from './dto/upsert-document.dto';

type UploadedImageFile = {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
};

const SUPPORTED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

@Injectable()
export class DocumentsService {
  private readonly maxBodyChars: number;
  private readonly maxImageBytes: number;
  private readonly supabaseUrl: string | null;
  private readonly supabaseServiceRoleKey: string | null;
  private readonly storageBucket: string;
  private ensureBucketPromise: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accessService: AccessService,
    private readonly sanitizeService: SanitizeService,
    private readonly configService: ConfigService,
    private readonly runtimeCache: RuntimeCacheService,
    private readonly metrics: RuntimeMetricsService,
  ) {
    const configured = Number(this.configService.get('DOCUMENT_MAX_BODY_CHARS') ?? 200_000);
    this.maxBodyChars = Number.isFinite(configured)
      ? Math.max(1_000, Math.trunc(configured))
      : 200_000;

    const imageBytes = Number(this.configService.get('UPLOAD_MAX_IMAGE_BYTES') ?? 5 * 1024 * 1024);
    this.maxImageBytes = Number.isFinite(imageBytes)
      ? Math.max(100 * 1024, Math.trunc(imageBytes))
      : 5 * 1024 * 1024;

    this.supabaseUrl = this.configService
      .get<string>('SUPABASE_URL')
      ?.trim()
      .replace(/\/$/, '') ?? null;
    this.supabaseServiceRoleKey =
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY')?.trim() ?? null;
    this.storageBucket =
      this.configService.get<string>('SUPABASE_STORAGE_BUCKET')?.trim() ||
      'meanlok-images';
  }

  private throwVersionConflict(version: number): never {
    throw new ConflictException({
      message: '다른 변경사항이 먼저 저장되어 충돌이 발생했어요. 새로고침 후 다시 시도해 주세요.',
      error: {
        code: 'VERSION_CONFLICT',
        latestVersion: version,
      },
    });
  }

  private applyDelta(
    sourceBody: string,
    delta: { start: number; deleteCount: number; insertText: string },
  ) {
    if (delta.start > sourceBody.length) {
      throw new BadRequestException('Delta start is out of bounds');
    }

    if (delta.start + delta.deleteCount > sourceBody.length) {
      throw new BadRequestException('Delta delete range is out of bounds');
    }

    return (
      sourceBody.slice(0, delta.start) +
      delta.insertText +
      sourceBody.slice(delta.start + delta.deleteCount)
    );
  }

  private sanitizeMarkdown(body: string) {
    return body
      .replace(
        /<\s*(script|iframe|style|object|embed|form)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi,
        '',
      )
      .replace(/<\s*(script|iframe|style|object|embed|form)\b[^>]*\/?>/gi, '')
      .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\]\(\s*(?:javascript|vbscript|data):[^)]*\)/gi, '](#)');
  }

  private encodedObjectPath(path: string) {
    return path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  }

  private toSignedUrl(signedPath: string) {
    if (!this.supabaseUrl) {
      throw new ServiceUnavailableException(
        'Supabase storage settings are not configured',
      );
    }

    if (/^https?:\/\//i.test(signedPath)) {
      return signedPath;
    }

    if (signedPath.startsWith('/storage/v1/')) {
      return `${this.supabaseUrl}${signedPath}`;
    }

    if (signedPath.startsWith('/')) {
      return `${this.supabaseUrl}/storage/v1${signedPath}`;
    }

    return `${this.supabaseUrl}/storage/v1/${signedPath}`;
  }

  private looksLikeJwtToken(value: string) {
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
  }

  private async fetchStorage(path: string, init?: RequestInit) {
    if (!this.supabaseUrl || !this.supabaseServiceRoleKey) {
      throw new ServiceUnavailableException(
        'Supabase storage settings are not configured',
      );
    }

    const headers = new Headers(init?.headers);
    headers.set('apikey', this.supabaseServiceRoleKey);

    // Supabase supports JWT-style service_role keys and sb_secret keys.
    // For sb_secret keys, forcing Bearer auth can trigger signature verification errors.
    if (this.looksLikeJwtToken(this.supabaseServiceRoleKey)) {
      headers.set('Authorization', `Bearer ${this.supabaseServiceRoleKey}`);
    }

    return fetch(`${this.supabaseUrl}${path}`, {
      ...init,
      headers,
    });
  }

  private async ensureBucketExists() {
    if (this.ensureBucketPromise) {
      return this.ensureBucketPromise;
    }

    this.ensureBucketPromise = (async () => {
      const bucketId = encodeURIComponent(this.storageBucket);
      const existing = await this.fetchStorage(`/storage/v1/bucket/${bucketId}`);
      if (existing.ok) {
        await existing.arrayBuffer().catch(() => undefined);
        return;
      }

      const existingText = await existing.text().catch(() => '');
      const isMissingBucket =
        existing.status === 404 ||
        /bucket.+not found|not found/i.test(existingText);

      if (!isMissingBucket) {
        const isAuthFailure =
          existing.status === 401 ||
          existing.status === 403 ||
          /signature verification failed|unauthorized/i.test(existingText);

        if (isAuthFailure) {
          throw new ServiceUnavailableException({
            message:
              'Supabase Storage 인증에 실패했어요. SUPABASE_SERVICE_ROLE_KEY 또는 프로젝트 설정을 확인해 주세요.',
            error: {
              code: 'STORAGE_AUTH_FAILED',
              statusCode: existing.status,
              details: existingText || null,
            },
          });
        }

        throw new BadGatewayException(
          `Failed to verify storage bucket (${existing.status}): ${existingText || 'unknown error'}`,
        );
      }

      const created = await this.fetchStorage('/storage/v1/bucket', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: this.storageBucket,
          name: this.storageBucket,
          public: false,
          file_size_limit: this.maxImageBytes,
          allowed_mime_types: [...SUPPORTED_IMAGE_MIME_TYPES],
        }),
      });

      if (!created.ok) {
        const text = await created.text().catch(() => '');

        const isAuthFailure =
          created.status === 401 ||
          created.status === 403 ||
          /signature verification failed|unauthorized/i.test(text);
        if (isAuthFailure) {
          throw new ServiceUnavailableException({
            message:
              'Supabase Storage 버킷 생성 권한이 없어요. service role 키를 다시 확인해 주세요.',
            error: {
              code: 'STORAGE_AUTH_FAILED',
              statusCode: created.status,
              details: text || null,
            },
          });
        }

        throw new BadGatewayException(
          `Failed to create storage bucket (${created.status}): ${text || 'unknown error'}`,
        );
      }
    })().catch((error) => {
      this.ensureBucketPromise = null;
      throw error;
    });

    return this.ensureBucketPromise;
  }

  async uploadImage(
    workspaceId: string,
    pageId: string,
    user: Profile,
    file: UploadedImageFile | undefined,
  ) {
    const access = await this.accessService.assertPageAccess(user.id, pageId, 'EDITOR');
    if (access.workspaceId !== workspaceId) {
      throw new NotFoundException('Page not found');
    }

    if (!file) {
      throw new BadRequestException('Image file is required');
    }

    if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.mimetype)) {
      throw new BadRequestException({
        message: '지원하지 않는 이미지 형식입니다.',
        error: {
          code: 'IMAGE_TYPE_NOT_ALLOWED',
          allowed: [...SUPPORTED_IMAGE_MIME_TYPES],
        },
      });
    }

    if (file.size > this.maxImageBytes) {
      throw new BadRequestException({
        message: `이미지 파일은 최대 ${this.maxImageBytes}바이트까지 업로드할 수 있어요.`,
        error: {
          code: 'IMAGE_TOO_LARGE',
          maxBytes: this.maxImageBytes,
          currentBytes: file.size,
        },
      });
    }

    await this.ensureBucketExists();

    const extension = MIME_TO_EXTENSION[file.mimetype] ?? 'bin';
    const objectPath = [
      `workspace-${workspaceId}`,
      `page-${pageId}`,
      `${Date.now()}-${randomBytes(8).toString('hex')}.${extension}`,
    ].join('/');
    const encodedPath = this.encodedObjectPath(objectPath);

    const response = await this.fetchStorage(
      `/storage/v1/object/${encodeURIComponent(this.storageBucket)}/${encodedPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': file.mimetype,
          'x-upsert': 'false',
        },
        body: new Uint8Array(file.buffer),
      },
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const isAuthFailure =
        response.status === 401 ||
        response.status === 403 ||
        /signature verification failed|unauthorized/i.test(text);

      if (isAuthFailure) {
        throw new ServiceUnavailableException({
          message:
            'Supabase Storage 업로드 인증에 실패했어요. service role 키를 확인해 주세요.',
          error: {
            code: 'STORAGE_AUTH_FAILED',
            statusCode: response.status,
            details: text || null,
          },
        });
      }

      throw new BadGatewayException(
        `Image upload failed (${response.status}): ${text || 'unknown error'}`,
      );
    }

    const signedUrlResponse = await this.fetchStorage(
      `/storage/v1/object/sign/${encodeURIComponent(this.storageBucket)}/${encodedPath}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          expiresIn: 3600,
        }),
      },
    );

    if (!signedUrlResponse.ok) {
      const text = await signedUrlResponse.text().catch(() => '');
      throw new BadGatewayException(
        `Failed to create signed image URL (${signedUrlResponse.status}): ${text || 'unknown error'}`,
      );
    }

    const signedPayload = (await signedUrlResponse
      .json()
      .catch(() => null)) as { signedURL?: string; signedUrl?: string } | null;
    const signedPath = signedPayload?.signedURL ?? signedPayload?.signedUrl;
    if (!signedPath) {
      throw new BadGatewayException('Failed to create signed image URL');
    }

    return {
      url: this.toSignedUrl(signedPath),
      path: objectPath,
      bucket: this.storageBucket,
      contentType: file.mimetype,
      size: file.size,
    };
  }

  async upsert(
    workspaceId: string,
    pageId: string,
    user: Profile,
    dto: UpsertDocumentDto,
  ) {
    const startedAt = Date.now();
    let success = false;

    try {
      const access = await this.accessService.assertPageAccess(user.id, pageId, 'EDITOR');
      if (access.workspaceId !== workspaceId) {
        throw new NotFoundException('Page not found');
      }

      const hasBody = typeof dto.body === 'string';
      const hasDelta = Boolean(dto.delta);

      if (hasBody === hasDelta) {
        throw new BadRequestException({
          message: 'body 또는 delta 중 하나만 전달해 주세요.',
          error: { code: 'INVALID_DOCUMENT_PATCH_PAYLOAD' },
        });
      }

      const existing = await this.prisma.document.findUnique({
        where: { pageId },
        select: {
          id: true,
          pageId: true,
          body: true,
          format: true,
          version: true,
          updatedAt: true,
        },
      });

      const rawBody = hasBody
        ? (dto.body ?? '')
        : this.applyDelta(existing?.body ?? '', {
            start: dto.delta!.start,
            deleteCount: dto.delta!.deleteCount,
            insertText: dto.delta!.insertText,
          });

      if (rawBody.length > this.maxBodyChars) {
        throw new BadRequestException({
          message: `문서 길이는 최대 ${this.maxBodyChars}자까지 저장할 수 있어요.`,
          error: {
            code: 'DOCUMENT_TOO_LARGE',
            maxChars: this.maxBodyChars,
            currentChars: rawBody.length,
          },
        });
      }

      const body =
        dto.format === DocFormat.HTML
          ? this.sanitizeService.sanitize(rawBody)
          : this.sanitizeMarkdown(rawBody);

      if (!existing) {
        const created = await this.prisma.document.create({
          data: {
            pageId,
            body,
            format: dto.format,
          },
        });

        this.runtimeCache.invalidatePage(pageId);
        success = true;
        return created;
      }

      if (dto.expectedVersion !== undefined && dto.expectedVersion !== existing.version) {
        this.throwVersionConflict(existing.version);
      }

      if (existing.body === body && existing.format === dto.format) {
        return existing;
      }

      const expectedVersion = dto.expectedVersion ?? existing.version;
      const updated = await this.prisma.document.updateMany({
        where: {
          pageId,
          version: expectedVersion,
        },
        data: {
          body,
          format: dto.format,
          version: {
            increment: 1,
          },
        },
      });

      if (updated.count === 0) {
        const latest = await this.prisma.document.findUnique({
          where: { pageId },
          select: { version: true },
        });
        this.throwVersionConflict(latest?.version ?? expectedVersion);
      }

      const nextDocument = await this.prisma.document.findUnique({
        where: { pageId },
      });

      if (!nextDocument) {
        throw new NotFoundException('Document not found');
      }

      this.runtimeCache.invalidatePage(pageId);
      success = true;

      return nextDocument;
    } finally {
      this.metrics.recordDocumentSave({
        durationMs: Date.now() - startedAt,
        success,
      });
    }
  }
}
