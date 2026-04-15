import { IsString, Matches } from 'class-validator';

const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export class WorkspaceParamDto {
  @IsString()
  @Matches(RESOURCE_ID_PATTERN, {
    message: 'workspaceId 형식이 올바르지 않습니다.',
  })
  workspaceId!: string;
}

export class WorkspacePageParamDto extends WorkspaceParamDto {
  @IsString()
  @Matches(RESOURCE_ID_PATTERN, {
    message: 'pageId 형식이 올바르지 않습니다.',
  })
  pageId!: string;
}
