# Billets offerts par le créateur — Design

Date : 2026-09-01
Branche : `feat/agent-creation-login-scanTicket`

## Objectif

Permettre au **créateur d'un événement** d'émettre des billets **offerts** (gratuits) pour
son propre événement, distincts des billets achetés. Ces billets sont scannables à l'entrée
comme les autres, mais n'entrent jamais dans le calcul financier du dashboard.

## Règles métier

- Billets **gratuits** : montants à 0, **aucune commission**.
- **Max 10 billets offerts par catégorie** (quel que soit le forfait, limité ou illimité).
- **Éligibilité** :
  - forfait **illimité** (`event.totalCapacity = null`) → toujours autorisé ;
  - forfait **limité** → autorisé seulement si `event.totalCapacity > 50`.
  - Raison : empêcher un créateur de souscrire ~10 billets et de tous les offrir, pour que la
    plateforme ne perçoive aucune commission.
- Les billets offerts **consomment le stock** de la catégorie (`soldCount`, plafonné par
  `totalStock`) : anti-survente cohérent avec le scan physique à l'entrée.

## Modèle de données

### `PaymentStatus` (enum Prisma) — ajouter `GIFT`

Un billet offert est porté par une `Order` avec `paymentStatus = GIFT` et tous les montants à 0
(`unitPrice`, `totalAmount`, `platformFee`, `organizerAmount`).

Choix clé : toutes les requêtes finances filtrent déjà `paymentStatus = 'PAID'`. En posant
`GIFT`, les offerts sont **automatiquement exclus** du calcul financier — aucun filtre
supplémentaire à maintenir.

*Alternative écartée* : `isGift Boolean` sur `Order` en gardant `PAID`. Rejetée car il faudrait
ajouter `isGift = false` à chaque requête finance (maintenance + risque d'oubli). L'enum `GIFT`
est auto-excluant.

### `Ticket` — ajouter `giftDownloadedAt DateTime?`

- `null` pour les billets normaux et pour un billet offert pas encore téléchargé.
- Horodaté au **premier téléchargement** d'un billet offert.
- Sert la règle de « disparition » de l'onglet Tickets offerts.

Migration Prisma dédiée (ne PAS lancer `prisma format` — reformate tout le schéma).

## Endpoint — émission

`POST /events/:reference/gifts` — authentifié, **créateur uniquement** (même garde que
`POST /events/:reference/agents`).

Body : `{ ticketCategoryId: string, quantity: number }`.

Contrôles **avant** toute transaction :
1. Événement existe (sinon 404) et appartient au user connecté (sinon 403).
2. Catégorie appartient bien à l'événement (sinon 404).
3. Éligibilité forfait : limité → `totalCapacity > 50` ; illimité → OK (sinon 403).
4. Plafond : `(billets offerts déjà émis sur cette catégorie) + quantity ≤ 10` (sinon 400).

Transaction (`$transaction`) :
- Réservation atomique anti-survente :
  `UPDATE "TicketCategory" SET "soldCount" = "soldCount" + qty
   WHERE id = :id AND ("totalStock" IS NULL OR "soldCount" + qty <= "totalStock")`
  → 0 ligne affectée = `ConflictException('Stock insuffisant …')`.
- Crée l'`Order` GIFT (montants 0, `paymentStatus: GIFT`).
- Crée `quantity` `Ticket` (`qrToken` = UUID, `expiresAt` = `event.endDate`).

Réponse : `{ orderId, tickets: [{ id }] }` (on ne renvoie jamais le `qrToken` brut).

## Onglet « Tickets offerts » (Mes billets)

- Les onglets normaux `upcoming`/`past` (`getMyTickets`) **excluent** les billets GIFT
  (`order.paymentStatus != GIFT`).
- Nouveau `GET /me/tickets/gifts` : billets offerts du user connecté, **visibles seulement si**
  `qrStatus = UNUSED` **ET** `giftDownloadedAt IS NULL`.
- Téléchargement : au premier `GET /me/tickets/:id/download` d'un billet GIFT, poser
  `giftDownloadedAt = now()` après le rendu. Conséquence : **disparition définitive et
  irréversible** dès téléchargement ou scan (USED). Perte du fichier = billet non
  re-téléchargeable (décision produit assumée).
- **Pas de flou QR** sur les offerts (contrairement aux billets achetés USED/CANCELLED) :
  ils disparaissent, ils ne s'affichent jamais grisés.

## Dashboard de scans

- **Finances : inchangées** — `GIFT ≠ PAID`, donc `gross/net/platformFee/paidOrders/soldTickets`
  et `revenue` par catégorie excluent déjà les offerts.
- Nouveau bloc `gifts: { total: number, byCategory: [{ name, count }] }` = comptage des billets
  GIFT (l'« espace offerts gratuitement » demandé).
- `byCategory` : `sold` reste `soldCount` (les offerts sont inclus car ils consomment le stock),
  mais on ajoute `gifted` par catégorie pour la transparence
  → vente payante réelle = `sold - gifted`. `remaining` reste correct (offerts comptés).

## Tests

Spec `agent.service.spec.ts` (émission + dashboard) et `MyTickets.*.spec.ts` :
- émission : succès (crée Order GIFT + N tickets, `soldCount += qty`) ;
- plafond : 10e OK, 11e refusé ;
- éligibilité : limité `totalCapacity ≤ 50` refusé, limité `> 50` OK, illimité OK ;
- anti-survente : `soldCount + qty > totalStock` → conflit ;
- non-créateur → 403 ;
- gift tab : ne montre que `UNUSED` + `giftDownloadedAt IS NULL` ; exclus des onglets normaux ;
- download d'un GIFT → pose `giftDownloadedAt` ;
- dashboard : bloc `gifts` correct, finances intactes (GIFT non comptés), `gifted` par catégorie.

## Hors périmètre (YAGNI)

- Pas d'envoi email des billets offerts (le créateur les télécharge et distribue lui-même).
- Pas de destinataire nommé par billet (rattachés au compte du créateur).
- Front (onglet Tickets offerts, bloc dashboard) : traité côté `vybeFrontend` après le backend.
