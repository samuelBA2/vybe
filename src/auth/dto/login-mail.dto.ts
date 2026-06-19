import { IsEmail, IsNotEmpty } from 'class-validator';
export class LoginEmailDto {
  @IsNotEmpty() @IsEmail() email: string;
}
