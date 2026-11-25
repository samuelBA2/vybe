import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class TicketCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsString()
  @IsNotEmpty()
  ticketDesignUrl: string;

  // Requis uniquement en stock limité : allocation de billets pour cette catégorie.
  @IsOptional()
  @IsInt()
  @Min(1)
  totalStock?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPerOrder?: number;

  @IsOptional()
  @IsString()
  benefits?: string;

  // Ouvre la réservation (cash à la porte) sur CETTE catégorie. Honoré uniquement sur la
  // catégorie de base (index 0) ; rejeté sur les catégories spéciales par EventsService.
  @IsOptional()
  @IsBoolean()
  reservationEnabled?: boolean;
}
