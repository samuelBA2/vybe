import { IsPhoneNumber, IsString, Length } from 'class-validator'
export class VerifyOtpDto {
    identifer: string
    code: string
    @IsPhoneNumber() phone: string
    @IsString() @Length(6, 6) otp: string
}