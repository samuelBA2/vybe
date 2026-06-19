import { IsString, Length } from 'class-validator';

export class VerifyAccountDeletionDto {
  @IsString()
  @Length(6, 6, { message: 'Le code OTP doit contenir 6 chiffres.' })
  otp: string;
}
