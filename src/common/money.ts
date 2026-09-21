import {
  PLATFORM_FEE_RATE,
  PAYOUT_MIN_AMOUNT,
  PAYOUT_MAX_AMOUNT,
  USD_TO_CDF_RATE,
} from './constants';

const round2 = (n: number) => Math.round(n * 100) / 100;

// Split commission/organisateur dans la devise donnée. USD : 2 décimales.
// CDF : entiers (PawaPay refuse les décimales) — le fee est arrondi, l'organisateur
// prend le reste pour que fee + organizer == total exactement.
export function splitAmount(
  total: number,
  currency: 'USD' | 'CDF',
): { platformFee: number; organizerAmount: number } {
  if (currency === 'CDF') {
    const platformFee = Math.round(total * PLATFORM_FEE_RATE);
    return { platformFee, organizerAmount: total - platformFee };
  }
  const platformFee = round2(total * PLATFORM_FEE_RATE);
  return { platformFee, organizerAmount: round2(total - platformFee) };
}

// Bornes min/max de retrait (FILET défensif), exprimées dans la devise demandée.
// Les bornes de base sont pensées en USD ; pour le CDF on applique le taux figé
// USD_TO_CDF_RATE UNIQUEMENT au filet — jamais dans le chemin de l'argent réel.
// Le vrai min/max par opérateur/devise (active-conf) reste le câblage sandbox.
export function payoutBounds(currency: 'USD' | 'CDF'): {
  min: number;
  max: number;
} {
  if (currency === 'CDF') {
    return {
      min: Math.round(PAYOUT_MIN_AMOUNT * USD_TO_CDF_RATE),
      max: Math.round(PAYOUT_MAX_AMOUNT * USD_TO_CDF_RATE),
    };
  }
  return { min: PAYOUT_MIN_AMOUNT, max: PAYOUT_MAX_AMOUNT };
}
