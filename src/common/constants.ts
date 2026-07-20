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
