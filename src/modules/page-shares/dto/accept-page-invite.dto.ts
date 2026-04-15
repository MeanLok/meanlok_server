import { IsNotEmpty, IsString, Length } from 'class-validator';

export class AcceptPageInviteDto {
  @IsString()
  @IsNotEmpty()
  @Length(20, 128)
  token!: string;
}
