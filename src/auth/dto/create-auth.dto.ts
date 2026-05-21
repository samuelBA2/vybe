// auth/dto/auth.dto.ts
import { IsEmail, IsOptional, IsPhoneNumber, IsString, MinLength, Matches, Length, IsNotEmpty, IsEnum } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAuthDto {
    @IsOptional()
    @IsEmail({}, { message: 'Email invalide' })
    email?: string;

    @IsOptional()
    @IsPhoneNumber('FR', { message: 'Numéro de téléphone invalide' })
    phone?: string;
}

export class VerifyOtpDto {
    @IsString()
    @Length(6, 6, { message: 'Le code doit contenir 6 chiffres' })
    @Matches(/^[0-9]{6}$/, { message: 'Le code doit être numérique' })
    code: string;

    @IsString()
    identifier: string;
}

export class RegisterDto {
    @IsString()
    firstName: string;

    @IsString()
    lastName: string;

    @IsString()
    @MinLength(8, { message: 'Le mot de passe doit contenir au moins 8 caractères' })
    @Matches(/[A-Z]/, { message: 'Le mot de passe doit contenir au moins une majuscule' })
    @Matches(/[a-z]/, { message: 'Le mot de passe doit contenir au moins une minuscule' })
    @Matches(/[0-9]/, { message: 'Le mot de passe doit contenir au moins un chiffre' })
    @Matches(/[@$!%*?&]/, { message: 'Le mot de passe doit contenir un caractère spécial' })
    password: string;

    @IsString()
    confirmPassword: string;

    @IsString()
    identifier: string; // email ou téléphon

    @IsNotEmpty()
    @IsEnum([ 'ORGANIZER, AGENT'])
    role: 'ORGANIZER' | 'AGENT' | 'SPECTATOR' ;
}
