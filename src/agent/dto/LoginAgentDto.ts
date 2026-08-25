import { IsString, IsNotEmpty, Matches } from "class-validator";
import { Transform } from 'class-transformer';

export class LoginAgentDto {
    @IsString({ message: 'Le code doit être une chaîne.' })
    @IsNotEmpty({ message: 'Le code est requis.' })
    @Transform(({ value }) => value?.trim().toUpperCase())
    @Matches(/^AG-[A-Z0-9]{8}$/, { message: 'Format de code invalide.' })
    code: string;
}