import { PartialType } from '@nestjs/mapped-types';
import { CreateAgentDto } from './create-agent.dto';
import { Transform } from 'class-transformer';
import sanitizeHtml from 'sanitize-html';
import { IsOptional, IsString, IsUrl, MinLength, MaxLength, minLength, Matches, Validate, ValidatorConstraint, ValidatorConstraintInterface, ValidationArguments} from 'class-validator'


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
    //Condition pour le mots de passe
    const PASSWORD_REGEX =  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&_\-#])[A-Za-z\d@$!%*?&_\-#]+$/;



export class UpdateUserDto {
    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    @Transform(({ value }) => sanitizeHtml(value.trim(), { allowedTags: []}))
    firstName?: string;

    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    @Transform(({ value }) => sanitizeHtml(value.trim(), { allowedTags: []}))
    lastName?: string;

    @IsOptional()
    @IsUrl({ protocols: ['https'], require_tld: true})
    avatarUrl?: string;

}
