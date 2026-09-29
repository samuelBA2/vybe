import { randomBytes } from 'crypto';

// Alphabet base32 (RFC 4648) : A-Z + 2-7, lisible et sans ambiguïté pour le support.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PREFIX = 'VB';
// 2 + 18 = 20 caractères : limite ARAKA de `transactionReference` (String(20)).
const RANDOM_LENGTH = 18;

// Référence de transaction partagée avec le fournisseur (paymentRef / payoutRef).
// ARAKA ne déduplique PAS les références : l'unicité repose sur ces ~90 bits
// d'aléa (18 × 5 bits) et sur le fait qu'on ne ré-initie jamais une référence.
export function newTransactionRef(): string {
  const bytes = randomBytes(RANDOM_LENGTH);
  let out = PREFIX;
  // 256 est multiple de 32 : `b & 31` reste uniforme.
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}
