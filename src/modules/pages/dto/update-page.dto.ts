import { Type } from 'class-transformer';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const CUID_PATTERN = /^c[a-z0-9]{20,}$/i;

export class UpdatePageDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  icon?: string | null;

  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN)
  parentId?: string | null;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  order?: number;
}
