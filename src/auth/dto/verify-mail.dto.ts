import { IsString, IsNotEmpty } from 'class-validator';

export class VerifyEmailOtpDto {
    @IsString()
    @IsNotEmpty()
    otp: string;
}