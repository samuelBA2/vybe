import { IsUUID, IsNotEmpty } from "class-validator"

export class ScanDto{
    @IsNotEmpty({ message : "Le QR code est requis."})
    @IsUUID('4', { message: 'QR invalide.' })
    qrToken : string
}   