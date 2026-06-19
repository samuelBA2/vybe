import { IsString, IsEmail, IsPhoneNumber, ValidateIf } from 'class-validator';

export class ChangeIdentifierDto {
  // L'un ou l'autre pas les deux
  @ValidateIf((o) => !o.newPhone)
  @IsEmail({}, { message: 'Adresse email invalide.' })
  newEmail?: string;

  @ValidateIf((o) => !o.newEmail)
  @IsPhoneNumber(undefined, { message: 'Numéro de téléphone invalide.' })
  newPhone?: string;
}
