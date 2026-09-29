import { newTransactionRef } from './transaction-ref';

describe('newTransactionRef', () => {
  it('20 caractères, préfixe VB, alphabet base32', () => {
    const ref = newTransactionRef();
    expect(ref).toHaveLength(20);
    expect(ref).toMatch(/^VB[A-Z2-7]{18}$/);
  });

  it('aucun doublon sur 10 000 tirages', () => {
    const refs = new Set(
      Array.from({ length: 10_000 }, () => newTransactionRef()),
    );
    expect(refs.size).toBe(10_000);
  });
});
