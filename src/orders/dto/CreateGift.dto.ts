import { IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_GIFTS_PER_CATEGORY } from 'src/common/constants';

// Émission de billets offerts pour UNE catégorie. quantity bornée à 10 côté DTO ;
// le plafond réel (cumul déjà offert) est vérifié dans le service.
export class CreateGiftDto {
  @IsUUID('4', { message: 'Catégorie de billet invalide.' })
  ticketCategoryId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_GIFTS_PER_CATEGORY)
  quantity: number;
}
