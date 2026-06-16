import { IsString, Length } from 'class-validator';

export class VerifyIdentifierDto {
    @IsString()
    @Length(6, 6, { message : 'Le code OTP doit contenir 6 chiffres.'})
    otp: string
}