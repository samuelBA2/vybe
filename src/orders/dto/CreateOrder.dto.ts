import { IsUUID, IsInt, Min, IsArray, ArrayMinSize, ArrayMaxSize, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

// Une ligne de panier : une catégorie + une quantité (jamais de prix — le
// montant fait foi côté serveur).
export class OrderItemDto {
    @IsUUID('4', { message: 'Catégorie de billet invalide.' })
    ticketCategoryId : string;

    @Type(() => Number)
    @Min(1)
    @IsInt()
    quantity : number;
}

// Panier : 1 à N catégories, commandées de façon ATOMIQUE (tout ou rien).
export class CreateOrderDto {
    @IsArray()
    @ArrayMinSize(1, { message: 'Le panier doit contenir au moins un billet.' })
    @ArrayMaxSize(20)
    @ValidateNested({ each: true })
    @Type(() => OrderItemDto)
    items : OrderItemDto[];
}
