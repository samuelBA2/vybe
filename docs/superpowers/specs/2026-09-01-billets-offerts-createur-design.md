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

### `TicketCategory` — ajouter `giftedCount Int @default(0)`

- Compteur O(1) des billets offerts émis sur la catégorie.
- Incrémenté **en même temps que `soldCount`** dans la transaction d'émission.
- Sert à la fois le **compteur X/10 de la carte** et le **bloc `gifts` du dashboard**, sans
  recompter les tickets par jointure.
- Plafond des 10 = simple lecture : `giftedCount + quantity ≤ 10`.

Migration Prisma dédiée (ne PAS lancer `prisma format` — reformate tout le schéma).

## Endpoint — émission

`POST /events/:reference/gifts` — authentifié, **créateur uniquement** (même garde que
`POST /events/:reference/agents`).

Body : `{ ticketCategoryId: string, quantity: number }`.

Contrôles **avant** toute transaction :
1. Événement existe (sinon 404) et appartient au user connecté (sinon 403).
2. Événement `PUBLISHED` et `purchaseDeadline` non dépassée (sinon 403) — mêmes gardes que la vente ; ferme l'endpoint direct sur un événement non validé, rejeté ou terminé.
3. Catégorie appartient bien à l'événement (sinon 404).
4. Éligibilité forfait : limité → `totalCapacity > 50` ; illimité → OK (sinon 403).
5. Plafond : `giftedCount + quantity ≤ 10` (sinon 400).

Transaction (`$transaction`) :
- Réservation atomique anti-survente + compteur d'offerts, en un seul UPDATE gardé :
  `UPDATE "TicketCategory"
     SET "soldCount" = "soldCount" + qty, "giftedCount" = "giftedCount" + qty
   WHERE id = :id
     AND "giftedCount" + qty <= 10
     AND ("totalStock" IS NULL OR "soldCount" + qty <= "totalStock")`
  → 0 ligne affectée = conflit (stock insuffisant **ou** plafond des 10 franchi par une
  émission concurrente). Le contrôle plafond de l'étape 4 reste un pré-check rapide ; l'UPDATE
  gardé est l'autorité anti-course.
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
- Nouveau bloc `gifts: { total: number, byCategory: [{ name, count }] }` = somme des
  `giftedCount` par catégorie (l'« espace offerts gratuitement » demandé). Lecture directe du
  champ, aucune agrégation de tickets.
- `byCategory` : `sold` reste `soldCount` (les offerts sont inclus car ils consomment le stock),
  mais on ajoute `gifted = giftedCount` par catégorie pour la transparence
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

## Front — carte événement (accueil)

La carte d'un événement est **identique** pour tous, sauf quand l'utilisateur connecté est le
**créateur** de cet événement (`event.createdById === currentUser.id`). Variante créateur :

1. **Bandeau** « Vous êtes l'organisateur de cet événement » juste au-dessus de la carte.
2. **Par catégorie** (ex. Standard) : à la place de l'input radio de sélection que voit le
   client, afficher un bouton **« Offrir un ticket »** + un **compteur `giftedCount/10`**
   (ex. `2/10` = 2 offerts sur 10, il en reste 8 à offrir). Le bouton ouvre un **sélecteur de
   quantité** (1 à `10 - giftedCount`) puis valide en un appel
   `POST /events/:reference/gifts { ticketCategoryId, quantity }`. Bouton désactivé quand
   `giftedCount = 10`.
3. **En bas au centre** : à la place du bouton **« Acheter »**, un bouton **« Dashboard »** qui
   redirige vers le dashboard de scans de l'événement.

### Support backend requis pour la carte

Le payload des événements exposé au front (`GET /events/:id` et la liste `findPublished`) doit
inclure, pour permettre au front de rendre la variante créateur :
- `createdById` sur l'événement (savoir si l'utilisateur connecté est propriétaire) ;
- `giftedCount` sur chaque `TicketCategory` (alimenter le compteur X/10).

Ces deux champs ne sont pas sensibles (pas de fuite : ils concernent l'offre, pas des données
personnelles).

### Décisions front

- **Offre par quantité** : le bouton ouvre un sélecteur de quantité (1 à `10 - giftedCount`),
  validé en un seul appel `POST /events/:reference/gifts`.
- **Compteur** : `giftedCount/10` = offerts / max (ex. `2/10` = 2 offerts, 8 restants).

## Hors périmètre (YAGNI)

- Pas d'envoi email des billets offerts (le créateur les télécharge et distribue lui-même).
- Pas de destinataire nommé par billet (rattachés au compte du créateur).
- Implémentation front (React/`vybeFrontend`) : réalisée après le backend ; ce design fige le
  contrat backend et le comportement attendu de la carte.
