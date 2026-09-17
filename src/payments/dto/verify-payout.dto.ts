import { IsString, Length } from 'class-validator';

// Étape 2 de la demande de retrait : confirmation par OTP à 6 chiffres.
export class VerifyPayoutDto {
  @IsString()
  @Length(6, 6)
  otp: string;
}
