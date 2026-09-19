import { splitAmount, payoutBounds } from './money';

describe('splitAmount', () => {
  it('USD : arrondi 2 décimales, fee + organizer = total', () => {
    const r = splitAmount(100, 'USD');
    expect(r.platformFee).toBe(20);
    expect(r.organizerAmount).toBe(80);
    expect(r.platformFee + r.organizerAmount).toBe(100);
  });

  it('USD : total non rond reste cohérent', () => {
    const r = splitAmount(49.99, 'USD');
    expect(r.platformFee + r.organizerAmount).toBeCloseTo(49.99, 2);
  });

  it('CDF : fee et organizer entiers, somme = total', () => {
    const r = splitAmount(15001, 'CDF');
    expect(Number.isInteger(r.platformFee)).toBe(true);
    expect(Number.isInteger(r.organizerAmount)).toBe(true);
    expect(r.platformFee + r.organizerAmount).toBe(15001);
  });
});

// Bornes de retrait (filet défensif) : USD inchangé, CDF = USD × taux figé
// (PAYOUT_MIN_AMOUNT=5, PAYOUT_MAX_AMOUNT=2000, USD_TO_CDF_RATE=2250).
describe('payoutBounds', () => {
  it('USD : bornes USD inchangées', () => {
    expect(payoutBounds('USD')).toEqual({ min: 5, max: 2000 });
  });

  it('CDF : bornes = bornes USD × taux (entiers)', () => {
    expect(payoutBounds('CDF')).toEqual({ min: 11250, max: 4500000 });
  });
});
