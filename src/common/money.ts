import { PLATFORM_FEE_RATE } from './constants';

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
