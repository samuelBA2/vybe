import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsPositive,
  IsString,
} from 'class-validator';
import { $Enums } from '@prisma/client';

// Étape 1 de la demande de retrait : devise du retrait + montant explicite (amount,
// dans cette devise) OU tout le solde retirable (all: true) ; destination Mobile
// Money (numéro + opérateur).
export class RequestPayoutDto {
  @IsEnum($Enums.Currency)
  currency: $Enums.Currency;

  @IsOptional()
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsBoolean()
  all?: boolean;

  @IsString()
  phoneNumber: string;

  @IsString()
  operator: string;
}
