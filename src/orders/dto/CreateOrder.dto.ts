import { IsUUID, IsNotEmpty, IsInt, Min } from "class-validator";
import { Type } from "class-transformer";

export class CreateOrderDto {
    @IsNotEmpty()
    @IsUUID('4', { message: 'Catégorie de billet invalide.' })
    ticketCategoryId : string;

    @Type(()=> Number)
    @Min(1)
    @IsInt()
    quantity : number;
}