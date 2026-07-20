import {
  IsString,
  MinLength,
  Matches,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator';

// Validateur croisé : confirmPassword doit égaler newPassword.
@ValidatorConstraint({ name: 'MatchNewPassword', async: false })
class MatchNewPassword implements ValidatorConstraintInterface {
  validate(confirmPassword: string, args: ValidationArguments) {
    const object = args.object as any;
    return confirmPassword === object.newPassword;
  }
  defaultMessage() {
    return 'Le mot de passe de confirmation ne correspond pas au nouveau mot de passe';
  }
}

// Réinitialisation du mot de passe via OTP. Même politique de complexité que la
// création de compte (complete-profile.dto.ts) : min 8, maj, min, chiffre, spécial.
export class ResetPasswordDto {
  @IsString()
  otp: string;

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
  newPassword: string;

  @IsString()
  @Validate(MatchNewPassword)
  confirmPassword: string;
}
