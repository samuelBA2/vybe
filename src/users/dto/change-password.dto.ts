import { IsString, MinLength, MaxLength, Matches } from 'class-validator';

// Au moins : 1 majuscule, 1 minuscule, 1 chiffre, 1 caractère spécial
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])[A-Za-z\d@$!%*?&_\-#]+$/;

export class ChangePasswordDto {
    @IsString()
    currentPassword: string;

    @IsString()
    @MinLength(8)
    @MaxLength(64)
    @Matches(PASSWORD_REGEX, {
    message:
        'Le mot de passe doit contenir au moins 1 majuscule, 1 minuscule, 1 chiffre et 1 caractère spécial (@$!%*?&_-#)',
    })
    newPassword: string;

    @IsString()
    confirmPassword: string;
}