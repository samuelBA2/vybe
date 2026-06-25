import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class ModerateDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';
}
