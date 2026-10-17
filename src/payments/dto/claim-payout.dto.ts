import { IsEnum, IsString, Matches } from 'class-validator';
import { $Enums } from '@prisma/client';

// Demande de retrait MANUEL (« Réclamer le net »). Le client ne retire pas
// lui-même : il signale à l'équipe Vybe sur quel numéro Mobile Money recevoir
// son solde net, et Vybe effectue l'envoi. Le MONTANT n'est jamais fourni par
// le client — il est recalculé côté serveur depuis le ledger (source de vérité).
export class ClaimPayoutDto {
  // Devise du solde réclamé (un organisateur peut détenir USD ET CDF, jamais sommés).
  @IsEnum($Enums.Currency, { message: 'Devise invalide.' })
  currency: $Enums.Currency;

  // Numéro Mobile Money de réception : chiffres uniquement, sans préfixe
  // international ni « + » (même règle que le push paiement).
  @IsString()
  @Matches(/^\d{6,15}$/, { message: 'Numéro Mobile Money invalide.' })
  mmoNumber: string;
}
