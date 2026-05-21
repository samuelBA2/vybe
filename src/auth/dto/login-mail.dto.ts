import { IsEmail, IsString, IsNotEmpty } from 'class-validator'
export class LoginEmailDto {
    @IsNotEmpty() @IsEmail() email: string
    @IsNotEmpty() @IsString() password: string
}
