import { IsBoolean, IsOptional, IsPositive, IsString } from 'class-validator';

// Étape 1 de la demande de retrait : montant explicite (amountUSD) OU tout le
// solde retirable (all: true) ; destination Mobile Money (numéro + opérateur).
export class RequestPayoutDto {
  @IsOptional()
  @IsPositive()
  amountUSD?: number;

  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @IsString()
  phoneNumber: string;

  @IsString()
  operator: string;
}
