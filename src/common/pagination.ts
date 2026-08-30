import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from './constants';

// Enveloppe de réponse paginée (keyset) : les éléments + un curseur opaque
// pointant la page suivante (null = plus de page). Rétro-compatible côté
// comportement : un appel sans limit/cursor renvoie la première page bornée
// par DEFAULT_PAGE_SIZE.
export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

// Curseur keyset : valeur de tri (ISO d'une date) + id en tie-breaker déterministe.
export interface KeysetCursor {
  v: string; // valeur de la colonne de tri (ISO), ex. startDate/createdAt
  id: string; // tie-breaker (clé primaire)
}

// Normalise le paramètre `limit` : défaut si absent, plafonné à MAX_PAGE_SIZE,
// minimum 1. Rejette une valeur non numérique explicite.
export function parseLimit(raw: string | number | undefined): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PAGE_SIZE;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < 1) throw new BadRequestException('Paramètre limit invalide.');
  return Math.min(Math.floor(n), MAX_PAGE_SIZE);
}

// Encode un curseur keyset en chaîne opaque (base64url).
export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

// Décode un curseur opaque. Absent → null (première page). Malformé → 400
// (jamais silencieusement ignoré, pour ne pas renvoyer une page fausse).
export function decodeCursor(raw: string | undefined): KeysetCursor | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (obj && typeof obj.v === 'string' && typeof obj.id === 'string') return obj as KeysetCursor;
  } catch {
    /* tombe dans le throw ci-dessous */
  }
  throw new BadRequestException('Curseur invalide.');
}

// À partir d'une page lue avec `take: limit + 1`, retourne les `limit` premiers
// éléments + le curseur suivant (construit depuis le dernier élément gardé) si
// une page de plus existe, sinon nextCursor = null.
export function buildPage<T>(
  rows: T[],
  limit: number,
  toCursor: (row: T) => KeysetCursor,
): Paginated<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? encodeCursor(toCursor(items[items.length - 1])) : null;
  return { items, nextCursor };
}
