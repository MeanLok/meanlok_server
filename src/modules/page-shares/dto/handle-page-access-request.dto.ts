import { IsEnum } from 'class-validator';

export enum PageAccessRequestAction {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class HandlePageAccessRequestDto {
  @IsEnum(PageAccessRequestAction)
  action!: PageAccessRequestAction;
}
