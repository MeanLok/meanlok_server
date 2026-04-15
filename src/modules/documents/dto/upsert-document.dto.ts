import { DocFormat } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class DocumentDeltaDto {
  @IsInt()
  @Min(0)
  start!: number;

  @IsInt()
  @Min(0)
  deleteCount!: number;

  @IsString()
  @MaxLength(200_000)
  insertText!: string;
}

export class UpsertDocumentDto {
  @IsOptional()
  @IsString()
  @MaxLength(500_000)
  body?: string;

  @IsEnum(DocFormat)
  format!: DocFormat;

  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => DocumentDeltaDto)
  delta?: DocumentDeltaDto;
}
