import { IsEmail } from 'class-validator';

export class SendEmailOtpDto {
  @IsEmail({}, { message: "L'adresse e-mail n'est pas valide." })
  email: string;
}
