import { IsPhoneNumber, IsString, IsNotEmpty} from 'class-validator'
export class LoginPhoneDto {
    @IsNotEmpty() @IsPhoneNumber () phone: string  
    @IsString() @IsNotEmpty() password: string
}