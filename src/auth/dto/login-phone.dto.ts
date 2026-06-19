import { IsPhoneNumber, IsNotEmpty } from 'class-validator';
export class LoginPhoneDto {
  @IsNotEmpty() @IsPhoneNumber() phone: string;
}
