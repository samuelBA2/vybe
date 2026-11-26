import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateReservationDto {
  @IsUUID('4', { message: 'Catégorie invalide.' })
  categoryId: string;

  @IsString()
  @IsNotEmpty({ message: 'Le prénom est requis.' })
  @MaxLength(80)
  holderFirstName: string;

  @IsString()
  @IsNotEmpty({ message: 'Le nom est requis.' })
  @MaxLength(80)
  holderLastName: string;

  @IsString()
  @IsNotEmpty({ message: 'Le téléphone est requis.' })
  @MaxLength(30)
  holderPhone: string;
}
