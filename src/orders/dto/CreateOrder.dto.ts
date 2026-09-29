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

    // ─── Push Mobile Money ──────────────────────────────────────────────────────
    // Code opérateur du fournisseur (ex. MPESA). Fourni par le frontend depuis la
    // liste des opérateurs de GET /payments/config.
    @IsString()
    @Matches(/^[A-Z0-9_]+$/, { message: 'Opérateur Mobile Money invalide.' })
    operator : string;

    // Numéro Mobile Money RDC normalisé : indicatif 243 + 9 chiffres, sans « + »
    // (le front normalise ; le provider ajoute le « + » attendu par ARAKA).
    @IsString()
    @Matches(/^243\d{9}$/, { message: 'Numéro Mobile Money invalide.' })
    phoneNumber : string;
}
