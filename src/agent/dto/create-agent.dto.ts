import { Transform } from "class-transformer";
import { IsString, IsNotEmpty, isEnum, IsEnum, Matches} from "class-validator";

export class CreateAgentDto {
    @IsString()
    @IsNotEmpty()
    firstname : string

    @IsString()
    @IsNotEmpty()
    lastname : string

    @IsNotEmpty()
    @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
    @IsString()
    @Matches(/^VYBE-[A-Z2-9]+$/, { message: 'Réference événement invalide.' })
    eventReferenceId: string; 

}
