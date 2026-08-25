import { Transform } from "class-transformer";
import { IsString, IsNotEmpty, Matches } from "class-validator";

export class CreateAgentDto {
    @IsString()
    @IsNotEmpty()
    firstname : string

    @IsString()
    @IsNotEmpty()
    lastname : string

    // Double sécurité : la référence est aussi dans l'URL (:reference).
    // Le service exige que les deux soient identiques (voir CreatAgent).
    @IsNotEmpty()
    @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
    @IsString()
    @Matches(/^VYBE-[A-Z2-9]+$/, { message: 'Réference événement invalide.' })
    eventReferenceId: string;
}
