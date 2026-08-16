# Brique D — Génération des visuels du billet (QR + image + PDF)

Date : 2026-08-15 (design révisé 2026-08-16)
Branche : `feat/agent-creation-login-scanTicket`
Statut : design validé, prêt pour le plan d'implémentation.

## Objectif

Après un achat (`POST /orders`, brique A déjà livrée), générer pour **chaque billet** une
**carte de billet** prête à afficher/scanner :

- une **image PNG** rendue à partir d'un gabarit fixe (largeur 750 px) ;
- un **PDF** reprenant ce PNG bord à bord (impression/téléchargement).

Les deux fichiers sont hébergés sur Cloudinary ; leurs URLs sont stockées sur le `Ticket`.

## Design de la carte (de haut en bas)

Référence visuelle : maquette fournie par l'utilisateur (billet « Neon Nights »).

1. **En-tête (image)** — l'image de design uploadée par l'organisateur
   (`TicketCategory.ticketDesignUrl`), recadrée en **cover** dans un bandeau d'en-tête à coins
   arrondis. Par-dessus, en bas à gauche : la **catégorie de l'événement** (`Event.category`,
   ex. « FESTIVAL », petite, majuscules, semi-transparente blanche) et le **titre de
   l'événement** (`Event.title`, ex. « Neon Nights », grand, gras, blanc). Un léger dégradé
   sombre en bas de l'image garantit la lisibilité du texte.
2. **Bandeau d'informations** (fond blanc) — trois colonnes séparées par de fins traits
   verticaux :
   - **DATE** → `Event.startDate` formaté fr (« Ven. 27 juin »),
   - **HEURE** → `Event.startDate` formaté fr (« 22:00 »),
   - **PLACE** → `TicketCategory.name` (la catégorie de billet, ex. « Standard »).
   Chaque colonne = un petit label gris en majuscules + une valeur en gras noir.
3. **Perforation** — trait horizontal pointillé, avec une encoche (demi-cercle) sur chaque
   bord latéral.
4. **QR code** — grand, centré, sur une carte blanche à coins arrondis. Généré à partir du
   `qrToken` **brut**.
5. **Pied de page** — un petit cadenas + le texte **« QR à usage unique »**. **Sans** la
   référence de l'événement (`Event.reference` n'apparaît PAS).

> Pas de couleur dérivée ni de palette : la seule source de couleur est l'image de design de
> l'organisateur. Aucun ruban, aucun accent de couleur par catégorie.

## Décisions actées

| Sujet | Décision |
|---|---|
| Emplacement de la génération | Post-commit **synchrone** : après le commit de la transaction `createOrder`, hors transaction. |
| Livrables | PNG (carte) **et** PDF, tous deux sur Cloudinary. |
| Champ image | `Ticket.ticketImageUrl String?` (déjà migré) à côté de `pdfUrl String?`. |
| Rendu | Gabarit **SVG** de largeur fixe (750 px), image de design embarquée (pré-recadrée cover), rasterisé en PNG via `sharp`. |
| Contenu du QR | Le `qrToken` **brut** (UUID v4, texte nu) — imposé par `ScanDto @IsUUID('4')`. |
| Pied de page | « QR à usage unique » **uniquement** (pas de `Event.reference`). |
| Gestion d'erreur post-commit | **Best-effort** : l'achat ne casse jamais ; en cas d'échec, `pdfUrl`/`ticketImageUrl` restent `null`, l'erreur est logguée, rattrapage paresseux en brique C. |
| PDF | `pdfkit`, page dimensionnée au PNG, image bord à bord. |

## Dépendances à installer

- `sharp` — recadrage cover de l'image de design + rasterisation du SVG.
- `pdfkit` + `@types/pdfkit` — génération PDF.
- `qrcode` (1.5.4) + `@types/qrcode` : **déjà installés**.

## Architecture — module `src/tickets/`

Isolation : la génération ne vit **pas** dans `OrderService` (focalisé sur l'achat), mais dans
un service dédié réutilisable par la brique A (post-commit) et la brique C (rattrapage).

```
src/tickets/
  tickets.module.ts             // fournit + exporte TicketAssetService
  ticket-asset.service.ts       // cœur : formatage + rendu SVG/PNG + PDF + upload + update
  ticket-asset.service.spec.ts  // tests unitaires
```

Dépendances injectées de `TicketAssetService` : `PrismaService`, `CloudinaryService`.

## Modèle de données

Migration déjà appliquée (`add_ticket_image_url`) : `Ticket.ticketImageUrl String?`.
Aucun autre modèle modifié (pas de champ couleur).

## Rendu — `buildTicketImage`

Signature :

```ts
type TicketFields = {
  qrToken: string;       // UUID brut
  eventCategory: string; // ex. "FESTIVAL"  (Event.category)
  eventTitle: string;    // ex. "Neon Nights" (Event.title)
  dateLabel: string;     // ex. "Ven. 27 juin"
  timeLabel: string;     // ex. "22:00"
  placeLabel: string;    // ex. "Standard" (TicketCategory.name)
};
buildTicketImage(designBuffer: Buffer, fields: TicketFields): Promise<Buffer> // PNG
```

Étapes :
1. Pré-recadrer `designBuffer` en cover aux dimensions de l'en-tête (`sharp(...).resize({ fit:
   'cover' })`) → PNG → base64 (data URI).
2. Générer le QR : `QRCode.toBuffer(qrToken, …)` → PNG → base64 (data URI).
3. Construire une chaîne **SVG** de largeur fixe reproduisant la carte (en-tête + texte,
   bandeau 3 colonnes, perforation, QR, pied de page). **Toute valeur texte issue de données
   (`eventTitle`, `eventCategory`, `placeLabel`, labels) est échappée XML** avant insertion.
4. Rasteriser le SVG via `sharp(Buffer.from(svg)).png().toBuffer()`.

La sortie a des **dimensions fixes** (largeur 750 px, hauteur constante déterminée par le
gabarit), indépendantes de l'image de design.

## Formatage des libellés

Effectué dans `generateAssetsForOrder` (qui dispose de l'`Event`) puis passé à
`buildTicketImage` :

- `dateLabel` : `startDate.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' })`, première lettre capitalisée (« Ven. 27 juin »).
- `timeLabel` : `startDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })` (« 22:00 »).
- `eventCategory` : `event.category` (valeur d'enum, déjà en majuscules).
- Caveat fuseau : `toLocale*` utilise le fuseau du serveur (pas de fuseau stocké par
  événement). Acceptable pour l'instant ; à revoir si un décalage pose problème.

## Flux — `TicketAssetService.generateAssetsForOrder(orderId: string)`

Appelé post-commit par `OrderService`. **Ne throw jamais**.

1. `prisma.ticket.findMany({ where: { orderId }, include: { ticketCategory: { include: { event: true } } } })`.
2. **Télécharger l'image de design une fois par catégorie** (cache de promesses par
   `ticketCategoryId` ; `fetch` global → `Buffer`).
3. Pour **chaque billet**, en parallèle via `Promise.allSettled` :
   1. Formater les libellés depuis `event`.
   2. `buildTicketImage(design, fields)` → PNG.
   3. Upload PNG → `cloudinary.uploadBuffer(png, TICKETS)` → `ticketImageUrl`.
   4. `buildTicketPdf(png)` → PDF.
   5. Upload PDF → `cloudinary.uploadRawBuffer(pdf, TICKETS, filename)` → `pdfUrl`.
   6. `prisma.ticket.update` avec les deux URLs.
4. Chaque échec de billet est loggué (billet laissé `null`, rattrapé en brique C).

## Cloudinary — méthode à ajouter

`CloudinaryService.uploadRawBuffer(buffer, folder, filename)` : `upload_stream` avec
`resource_type: 'raw'`, `format: 'pdf'`, `public_id: filename`. Le PNG réutilise `uploadBuffer`.

## Intégration `OrderService.createOrder`

Après le `$transaction` (qui renvoie l'`order`), appeler
`ticketAssets.generateAssetsForOrder(order.id)` **hors transaction**, en best-effort
(`try/catch` + log), puis recharger et retourner les billets avec
`qrToken`/`pdfUrl`/`ticketImageUrl`.

## Tests (`ticket-asset.service.spec.ts`)

- Le QR encode le `qrToken` brut (argument passé à `QRCode.toBuffer`).
- `buildTicketImage` renvoie un PNG de largeur fixe (750 px) quelle que soit la taille du design.
- Le SVG échappe les valeurs texte (un titre contenant `<`/`&` ne casse pas le rendu).
- L'image de design n'est téléchargée qu'**une fois par catégorie** pour plusieurs billets.
- Deux uploads par billet (PNG via `uploadBuffer`, PDF via `uploadRawBuffer`) puis
  `ticket.update` avec les deux URLs.
- Best-effort : l'échec d'un billet n'empêche pas les autres, la méthode **ne throw pas**.

## Hors périmètre

- Brique C (`GET /me/tickets`) — seulement anticipée (rattrapage).
- Brique E (dashboard scans), Brique B (paiement réel), Brique F (purges cron).
