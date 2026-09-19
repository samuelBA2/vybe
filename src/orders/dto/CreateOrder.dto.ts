import { IsUUID, IsInt, Min, IsArray, ArrayMinSize, ArrayMaxSize, ValidateNested, IsString, Matches } from "class-validator";
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

    // ─── Push Mobile Money (PawaPay) ────────────────────────────────────────────
    // Code opérateur du fournisseur (ex. VODACOM_MPESA_COD). Fourni par le frontend
    // depuis la liste des opérateurs disponibles.
    @IsString()
    @Matches(/^[A-Z0-9_]+$/, { message: 'Opérateur Mobile Money invalide.' })
    operator : string;

    // Numéro Mobile Money : chiffres uniquement, sans préfixe international ni +.
    @IsString()
    @Matches(/^\d{6,15}$/, { message: 'Numéro Mobile Money invalide.' })
    phoneNumber : string;
}
