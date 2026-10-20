import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/* Chiffrement réversible du code agent "AG-XXXXXXXX" (AES-256-GCM).
 *
 * Contrairement à hashCode (SHA-256, sens unique, sert au login), ce code
 * chiffré permet de le RÉAFFICHER à l'organisateur dans la liste des agents
 * (il peut ainsi le redonner à un agent qui l'a perdu).
 *
 * Clé : dérivée (scrypt) de AGENT_CODE_SECRET, sinon JWT_SECRET — aucune
 * nouvelle variable d'env obligatoire. Attention : si ce secret change, les
 * codes déjà stockés deviennent illisibles (decrypt → null) ; il faut alors
 * recréer les agents concernés. */

const KEY_SALT = 'vybe-agent-code';
let cachedKey: Buffer | null = null;

// Dérive une clé AES-256 (32 octets) du secret applicatif. Mémoïsée : scrypt
// est volontairement coûteux, on ne le calcule qu'une fois par process.
function key(): Buffer {
  if (cachedKey) return cachedKey;
  const secret = process.env.AGENT_CODE_SECRET ?? process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('AGENT_CODE_SECRET/JWT_SECRET manquant : impossible de chiffrer les codes agent.');
  }
  cachedKey = scryptSync(secret, KEY_SALT, 32);
  return cachedKey;
}

/** Chiffre un code agent → "ivB64:tagB64:ctB64" (à stocker dans Agent.codeEnc). */
export function encryptAgentCode(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

/** Déchiffre un code agent. Renvoie null si absent ou illisible (secret changé,
 *  donnée corrompue) pour ne JAMAIS casser la liste des agents à cause d'un code. */
export function decryptAgentCode(enc: string | null): string | null {
  if (!enc) return null;
  try {
    const [ivB64, tagB64, ctB64] = enc.split(':');
    if (!ivB64 || !tagB64 || !ctB64) return null;
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
