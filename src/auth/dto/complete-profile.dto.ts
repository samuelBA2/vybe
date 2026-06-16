import { IsString, IsEmail, MinLength, Matches, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments} from 'class-validator'

@ValidatorConstraint({ name: 'MatchPassword', async: false })
class MatchPassword implements ValidatorConstraintInterface {
    validate(confirmPassword: string, args: ValidationArguments) {
        const object = args.object as any;
        return confirmPassword === object.password;
    }
    defaultMessage(args: ValidationArguments) {
        return 'Le mot de passe de confirmation ne correspond pas au mot de passe';
    }
}

export class CompleteProfileDto {       

    @IsString()
    firstName: string

    @IsString()
    lastName: string

    @IsString()
    @MinLength(8, { message: 'Le mot de passe doit contenir au moins 8 caractères' })
    @Matches(/[A-Z]/, { message: 'Le mot de passe doit contenir au moins une majuscule' })
    @Matches(/[a-z]/, { message: 'Le mot de passe doit contenir au moins une minuscule' })
    @Matches(/[0-9]/, { message: 'Le mot de passe doit contenir au moins un chiffre' })
    @Matches(/[@$!%*?&]/, { message: 'Le mot de passe doit contenir un caractère spécial' })
    password: string;

    @IsString()
    @MinLength(8)
    @Validate(MatchPassword)
    confirmPassword: string;
}
