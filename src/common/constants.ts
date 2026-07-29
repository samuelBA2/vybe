// Coût (nombre de rounds) bcrypt pour le hachage des mots de passe.
// Constante partagée : garantit un coût identique à l'inscription et au
// changement de mot de passe (évite toute divergence 10 vs 12).
export const BCRYPT_ROUNDS = 12;

// ─── Verrou progressif de connexion par mot de passe ──────────────────────────
// Nombre de mots de passe faux consécutifs déclenchant un verrou.
export const MAX_LOGIN_ATTEMPTS = 5;

// Durées des paliers de verrou (en ms), indexées par loginLockLevel courant :
// 1er verrou → 5 min, 2e → 1 h, 3e et suivants → 12 h (dernière valeur réutilisée).
export const LOGIN_LOCK_DURATIONS_MS = [
  5 * 60 * 1000, // palier 1 : 5 minutes
  60 * 60 * 1000, // palier 2 : 1 heure
  12 * 60 * 60 * 1000, // palier 3+ : 12 heures
];

// ─── Upload de médias
export const MAX_BYTES = 15 * 1024 * 1024 

// MIME autorisés → validés par les MAGIC BYTES (jamais par le mimeType client).
export const ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
]);

// Mappagr d'un mime détecté vers le MediaType Prisma (source de vérité côté serveur)
export function mimeToMediaType(mime: string): 'IMAGE' | 'DOCUMENT' | 'OTHER' {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime === 'application/pdf') return 'DOCUMENT';
  return 'OTHER';
}