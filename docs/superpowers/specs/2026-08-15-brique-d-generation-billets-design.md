# Brique D — Génération des visuels du billet (QR + image + PDF)

Date : 2026-08-15
Branche : `feat/agent-creation-login-scanTicket`
Statut : design validé, prêt pour le plan d'implémentation.

## Objectif

Après un achat (`POST /orders`, brique A déjà livrée), générer pour **chaque billet** un
visuel prêt à afficher/scanner :

- une **image PNG** composée = image de design de la catégorie (`TicketCategory.ticketDesignUrl`)
  + un **QR code** (encodant le `qrToken`) dans un bandeau blanc ajouté sous l'image
  + un **ruban d'angle coloré** en haut à droite portant le nom de la catégorie (distinction
    visuelle forte entre catégories) ;
- un **PDF** reprenant ce PNG bord à bord (pour impression/téléchargement).

Les deux fichiers sont hébergés sur Cloudinary ; leurs URLs sont stockées sur le `Ticket`.

## Décisions actées

| Sujet | Décision |
|---|---|
| Emplacement de la génération | Post-commit **synchrone** : après le commit de la transaction `createOrder`, hors transaction. |
| Livrables | PNG composé **et** PDF, tous deux sur Cloudinary. |
| Champ image | Nouveau champ `Ticket.ticketImageUrl String?` (à côté de `pdfUrl String?` déjà présent). |
| Placement du QR | Bandeau blanc **ajouté sous** l'image de design (design jamais masqué), QR centré dedans. |
| Distinction de catégorie | **Ruban d'angle diagonal** en haut à **droite**, coloré, avec le nom de la catégorie. |
| Source de la couleur | **Dérivée déterministe** du nom : `hash(nom_normalisé) % palette.length`. Aucun champ DB, aucune modif du formulaire de création d'événement. |
| Contenu du QR | Le `qrToken` **brut** (UUID v4 en texte nu) — imposé par `ScanDto @IsUUID('4')`. |
| Gestion d'erreur post-commit | **Best-effort** : l'achat ne casse jamais ; en cas d'échec, `pdfUrl`/`ticketImageUrl` restent `null`, l'erreur est logguée, et le rattrapage se fait paresseusement en brique C (`GET /me/tickets`). |
| Compositing | `sharp` (canvas extend + composite de buffers PNG et SVG). |
| PDF | `pdfkit`, page dimensionnée au PNG, image bord à bord. |

## Dépendances à installer

- `sharp` — compositing image + rasterisation SVG du ruban.
- `pdfkit` + `@types/pdfkit` — génération PDF.
- `qrcode` (1.5.4) + `@types/qrcode` : **déjà installés**.

## Architecture — nouveau module `src/tickets/`

Isolation : la génération ne vit **pas** dans `OrderService` (qui reste focalisé sur l'achat).
Elle est portée par un service dédié, réutilisable par la brique A (post-commit) et la brique C
(rattrapage paresseux).

```
src/tickets/
  tickets.module.ts             // fournit + exporte TicketAssetService
  ticket-asset.service.ts       // cœur : QR + composition + PDF + upload + update
  ticket-asset.service.spec.ts  // tests unitaires
  ticket-palette.ts             // palette curée + helper colorForCategoryName()
```

Dépendances injectées de `TicketAssetService` : `CloudinaryService`, `PrismaService`.
`OrderModule` importe `TicketsModule` et `OrderService` appelle le service post-commit.

## Modèle de données

Migration Prisma — ajout d'un champ nullable sur `Ticket` :

```prisma
model Ticket {
  // ... champs existants ...
  pdfUrl          String?
  ticketImageUrl  String?   // NOUVEAU : URL Cloudinary du PNG composé (design + QR + ruban)
}
```

`pdfUrl` existe déjà. Aucun autre modèle n'est modifié (pas de champ couleur sur
`TicketCategory` : la couleur est dérivée du nom).

## Palette de couleurs (`ticket-palette.ts`)

- Un tableau constant de N couleurs hex à fort contraste (N ≈ 8–12).
- `colorForCategoryName(name: string): string` :
  1. normalise le nom (trim + lowercase + éventuel `normalize('NFD')` sans diacritiques),
  2. calcule un hash entier stable (ex. somme/rotation des char codes, ou djb2),
  3. renvoie `palette[hash % palette.length]`.
- Propriété : **stable par nom** — « VIP » a toujours la même couleur, y compris entre
  événements. Caveat connu et accepté : deux catégories d'un même événement peuvent, en cas
  de collision de hash (rare avec 1–4 catégories), tomber sur la même couleur. Alternative
  non retenue : rang par prix croissant (garantit la distinction intra-événement mais rend la
  couleur d'une catégorie dépendante de ses voisines).

## Flux — `TicketAssetService.generateAssetsForOrder(orderId: string)`

Appelé post-commit par `OrderService`. **Ne throw jamais** vers l'appelant.

1. Charger les billets de la commande avec leur `ticketCategory`
   (`prisma.ticket.findMany({ where: { orderId }, include: { ticketCategory: true } })`).
2. **Télécharger l'image de design une fois par catégorie** : `fetch(ticketDesignUrl)` (global
   `fetch`, Node 20) → `arrayBuffer` → `Buffer`. Mémoïser par `ticketCategoryId` pour ne pas
   re-télécharger entre billets d'une même catégorie.
3. Pour **chaque billet**, en parallèle via `Promise.allSettled` (une panne n'entraîne pas les
   autres) :
   1. `QRCode.toBuffer(qrToken, { errorCorrectionLevel: 'M', margin: 1, width: <px> })` → PNG du QR.
   2. Construire l'**SVG du ruban** : rectangle pivoté ~ -45° ancré dans le coin **haut-droit**,
      rempli de `colorForCategoryName(category.name)`, avec le nom de la catégorie en texte blanc.
   3. `sharp(designBuffer)` :
      - `.extend({ bottom: bandHeight, background: '#ffffff' })` (bandeau blanc sous l'image),
      - `.composite([{ input: qrPng, top, left } /* centré dans le bandeau */,
                      { input: ribbonSvgBuffer, top: 0, left: <coin droit> }])`,
      - `.png()` → **PNG du billet**.
   4. Upload PNG → `cloudinary.uploadBuffer(png, CloudinaryFolder.TICKETS)` → `ticketImageUrl`.
   5. `pdfkit` : nouveau document, `size: [pngWidth, pngHeight]`, `margin: 0`,
      `doc.image(pngBuffer, 0, 0, { width, height })` → collecter les chunks → **buffer PDF**.
   6. Upload PDF → **nouvelle méthode** `cloudinary.uploadRawBuffer(pdf, CloudinaryFolder.TICKETS, filename)`
      (resource_type `raw`, format `pdf`) → `pdfUrl`.
   7. `prisma.ticket.update({ where: { id }, data: { ticketImageUrl, pdfUrl } })`.
4. Chaque échec de billet est loggué (`Logger`) ; le billet reste avec des URLs `null`
   (rattrapé en brique C). La méthode retourne normalement.

## Cloudinary — méthode à ajouter

`CloudinaryService.uploadRawBuffer(buffer: Buffer, folder: string, filename: string)` :
`upload_stream` avec `resource_type: 'raw'` + `public_id`/`format: 'pdf'`, sur le modèle de
`uploadBuffer` existant (qui reste image-only et sert pour le PNG).

## Intégration dans `OrderService.createOrder`

Après le `return this.prisma.$transaction(...)` (déjà en place), remanier pour :
1. Récupérer le résultat de la transaction (`order` + `tickets`).
2. `try { await this.ticketAssets.generateAssetsForOrder(order.id); } catch (e) { logger.error(...); }`
   — best-effort, **hors transaction**.
3. Recharger/retourner les billets avec `pdfUrl`/`ticketImageUrl` remplis (ou `null` si échec).

`OrderService` reçoit `TicketAssetService` par injection (via `TicketsModule` importé dans
`OrderModule`).

## Rattrapage brique C (hors périmètre immédiat, mais pris en compte)

`GET /me/tickets` (brique C, prochaine étape) appellera `generateAssetsForOrder` (ou un helper
par-billet équivalent) pour les billets dont `pdfUrl`/`ticketImageUrl` sont encore `null`,
puis renverra les URLs à jour. Cette réutilisation justifie que la logique vive dans
`TicketAssetService` et non dans `OrderService`.

## Tests (`ticket-asset.service.spec.ts`)

`fetch`, `CloudinaryService` et `PrismaService` mockés.

- Le QR encode bien le `qrToken` brut (vérifier l'argument passé à `QRCode.toBuffer`).
- L'image de design n'est téléchargée qu'**une fois par catégorie** même pour plusieurs billets.
- La composition produit un PNG dont la hauteur = hauteur design + hauteur du bandeau.
- Deux uploads par billet (PNG via `uploadBuffer`, PDF via `uploadRawBuffer`) puis
  `ticket.update` avec les deux URLs.
- Best-effort : l'échec d'un billet (ex. upload qui rejette) n'empêche pas les autres billets
  d'aboutir, et la méthode **ne throw pas**.
- `colorForCategoryName` est déterministe (même entrée → même couleur) et insensible à la
  casse/aux espaces.

## Hors périmètre

- Brique C (`GET /me/tickets`) — seulement anticipée ici (rattrapage).
- Brique E (dashboard scans organisateur).
- Brique B (paiement réel `PENDING→PAID`, actuellement stubbé `PAID`).
- Brique F (purges cron).
- Choix de la couleur par l'organisateur (champ `accentColor`) — écarté au profit de la
  dérivation automatique par nom.
