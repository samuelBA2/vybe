import { IsString, Length, IsPhoneNumber, IsEmail} from 'class-validator'
export class VerifyOtpDto {


    @IsString() 
    @Length(6, 6) 
    otp: string
}