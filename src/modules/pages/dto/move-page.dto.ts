import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Matches } from 'class-validator';

const CUID_PATTERN = /^c[a-z0-9]{20,}$/i;

export class MovePageDto {
  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN)
  targetWorkspaceId?: string;

  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN)
  targetParentId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  order?: number;
}
