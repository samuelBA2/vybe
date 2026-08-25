import { createHash } from 'crypto';

// SHA-256 déterministe d'un code agent "AG-XXXXXXXX".
// Utilisé à la création (stockage dans Agent.hashCode) ET au login
// (lookup) → doit rester la SEULE implémentation pour que les deux
// hachent strictement à l'identique.
export const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');