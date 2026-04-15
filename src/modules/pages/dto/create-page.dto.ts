import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const CUID_PATTERN = /^c[a-z0-9]{20,}$/i;

export class CreatePageDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @Matches(CUID_PATTERN)
  parentId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  icon?: string | null;
}
