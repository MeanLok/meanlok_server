import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { tmpdir } from 'node:os';
import { diskStorage } from 'multer';
import type { Profile } from '@prisma/client';
import { WorkspacePageParamDto } from '../../common/dto/route-params.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PageAccess } from '../../common/decorators/page-access.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PageAccessGuard } from '../../common/guards/page-access.guard';
import { resolveUploadMaxImageBytes } from '../../shared/uploads/upload.constants';
import { UpsertDocumentDto } from './dto/upsert-document.dto';
import { DocumentsService } from './documents.service';

const IMAGE_UPLOAD_HARD_LIMIT_BYTES = resolveUploadMaxImageBytes(
  process.env.UPLOAD_MAX_IMAGE_BYTES,
);
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

@Controller('workspaces/:workspaceId/pages/:pageId/document')
@UseGuards(JwtAuthGuard, PageAccessGuard)
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @PageAccess('EDITOR')
  @Post('images')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_request, file, callback) => {
          const extension = extname(file.originalname ?? '').toLowerCase();
          callback(null, `${Date.now()}-${randomUUID()}${extension}`);
        },
      }),
      limits: {
        fileSize: IMAGE_UPLOAD_HARD_LIMIT_BYTES,
        files: 1,
      },
      fileFilter: (_request, file, callback) => {
        if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
          callback(
            new BadRequestException('지원하지 않는 이미지 형식입니다.'),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  uploadImage(
    @Param() params: WorkspacePageParamDto,
    @CurrentUser() user: Profile,
    @UploadedFile()
    file:
      | {
          buffer?: Buffer;
          path?: string;
          mimetype: string;
          size: number;
          originalname?: string;
        }
      | undefined,
  ) {
    return this.documentsService.uploadImage(
      params.workspaceId,
      params.pageId,
      user,
      file,
    );
  }

  @PageAccess('EDITOR')
  @Put()
  upsert(
    @Param() params: WorkspacePageParamDto,
    @CurrentUser() user: Profile,
    @Body() dto: UpsertDocumentDto,
  ) {
    return this.documentsService.upsert(
      params.workspaceId,
      params.pageId,
      user,
      dto,
    );
  }
}
