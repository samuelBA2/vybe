import {
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
}
