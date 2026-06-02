import { IsPhoneNumber } from 'class-validator'

export class SendPhoneOtpDto {
    @IsPhoneNumber()
    phone: string
}