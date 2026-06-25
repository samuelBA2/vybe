import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { $Enums } from '@prisma/client';
import { MediaItemDto } from './media-item.dto';
import { TicketCategoryDto } from './ticket-category.dto';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsISO8601()
  startDate: string;

  @IsISO8601()
  endDate: string;

  @IsString()
  @IsNotEmpty()
  location: string;

  @IsISO8601()
  purchaseDeadline: string;

  @IsEnum($Enums.EventCategory)
  category: $Enums.EventCategory;

  @IsOptional()
  @IsNumber()
  gpsLat?: number;

  @IsOptional()
  @IsNumber()
  gpsLng?: number;

  @IsOptional()
  @IsString()
  dressCode?: string;

  // Doit valoir explicitement true (l'utilisateur accepte les conditions).
  @Equals(true)
  termsAccepted: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  media: MediaItemDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => TicketCategoryDto)
  ticketCategories: TicketCategoryDto[];
}
