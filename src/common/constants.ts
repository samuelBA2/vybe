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


// Alphabet SANS caractères ambigus (pas de 0/O ni 1/I) : un code lisible,
// dictable au téléphone sans confusion. 32 caractères.
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ23456789';

// ─── Agents de sécurité ───────────────────────────────────────────────────────
// Nombre maximum d'agents ACTIFS par événement. Désactiver un agent
// (active=false) libère un slot. Le frontend applique la même limite pour
// désactiver le bouton « + ».
export const MAX_AGENTS_PER_EVENT = 5;

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

// ─── Dashboard / fuseau applicatif ────────────────────────────────────────────
// Fuseau IANA de la région de l'app (mono-région pour l'instant). Sert à
// bucketiser la timeline des scans en HEURE LOCALE de l'événement côté SQL,
// pour que l'organisateur ne voie pas des heures décalées (indépendamment du
// fuseau de son navigateur). Le jour du multi-région : stocker un fuseau par
// événement et l'utiliser à la place de cette constante.
export const APP_TIMEZONE = process.env.APP_TIMEZONE ?? 'Africa/Kinshasa';

// ─── Pagination (keyset) ──────────────────────────────────────────────────────
// Taille de page par défaut et plafond dur des listes paginées (events, mine).
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

// Garde-fou /me/tickets : ce n'est PAS une pagination (les billets d'un seul
// utilisateur sont naturellement bornés) mais un plafond de sécurité par scope
// (upcoming/past) pour ne jamais charger un volume pathologique en mémoire.
// Valeur volontairement hors de portée d'un utilisateur réel. Si elle est
// atteinte, la réponse le SIGNALE (champ `truncated`) — jamais de troncature
// silencieuse — et un warn est loggé côté serveur.
export const MY_TICKETS_MAX_PER_SCOPE = 1000;

// ─── Billetterie / commandes ──────────────────────────────────────────────────
// Commission Vybe prélevée sur chaque commande, déduite du montant reversé à
// l'organisateur (organizerAmount = totalAmount − platformFee).
export const PLATFORM_FEE_RATE = 0.15 // 15%

// Nombre maximum de billets qu'un créateur peut OFFRIR par catégorie. Le
// frontend applique la même limite (compteur X/10 + désactivation du bouton).
export const MAX_GIFTS_PER_CATEGORY = 10;

// ─── Paiement (indépendant du fournisseur) ────────────────────────────────────
// Taux de conversion USD → CDF FIGÉ pour la V1 (surchargeable en env). L'USD est
// la base comptable (montants Order/ledger) ; le CDF sert l'affichage et certains
// débits Mobile Money. À passer en taux « live » plus tard (Lot 2).
// (La commission plateforme PLATFORM_FEE_RATE = 0.15 existe déjà ci-dessus.)
export const USD_TO_CDF_RATE = Number(process.env.USD_TO_CDF_RATE ?? 2250); 

// Délai (minutes) au-delà duquel une commande PENDING non payée est expirée par
// le reaper. À garder > durée de vie du paiement côté fournisseur, pour ne jamais
// expirer un paiement encore en cours de validation par l'acheteur.
export const PAYMENT_PENDING_TTL_MINUTES = Number(
  process.env.PAYMENT_PENDING_TTL_MINUTES ?? 25,
);

// ─── Photo de profil (avatar) ────────────────────────────────────────────────
export const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 Mo

// Images uniquement — validées par MAGIC BYTES (jamais file.mimetype).
export const AVATAR_ALLOWED_MIME = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/webp',
]);

// Mappage d'un mime détecté vers le MediaType Prisma (source de vérité côté serveur)
export function mimeToMediaType(mime: string): 'IMAGE' | 'DOCUMENT' | 'OTHER' {
  if (mime.startsWith('image/')) return 'IMAGE';
  if (mime === 'application/pdf') return 'DOCUMENT';
  return 'OTHER';
}