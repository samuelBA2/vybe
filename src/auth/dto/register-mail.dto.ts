import {
  IsEmail,
  IsString,
  MinLength,
  IsNotEmpty,
  Matches,
} from 'class-validator';
export class RegisterEmailDto {
  @IsNotEmpty()
  @IsEmail()
  email: string;

  @IsString()
  firstName: string;

  @IsString()
  lastName: string;

  @IsString()
  @MinLength(8, {
    message: 'Le mot de passe doit contenir au moins 8 caractères',
  })
  @Matches(/[A-Z]/, {
    message: 'Le mot de passe doit contenir au moins une majuscule',
  })
  @Matches(/[a-z]/, {
    message: 'Le mot de passe doit contenir au moins une minuscule',
  })
  @Matches(/[0-9]/, {
    message: 'Le mot de passe doit contenir au moins un chiffre',
  })
  @Matches(/[@$!%*?&]/, {
    message: 'Le mot de passe doit contenir un caractère spécial',
  })
  password: string;

  @IsString()
  confirmPassword: string;
}
