# Création d'événement + modération — Design

**Date:** 2026-06-25
**Statut:** Validé (brainstorming)

## Objectif

Permettre à un utilisateur authentifié (rôle `ADMIN` — tous les comptes Vybe le sont
aujourd'hui) de créer un événement complet (données + médias + catégories de billets) en
un seul appel. Chaque création part en **modération** : un mail est envoyé à l'équipe Vybe
avec toutes les informations de l'événement et l'affiche ; l'équipe valide ou refuse via des
liens dans le mail. Tant qu'il n'est pas validé, l'événement n'est **pas** publié — ce qui
empêche n'importe qui de publier un événement librement.

## Décisions de cadrage (brainstorming)

1. **Périmètre** : `createEvent` crée `Event` + `EventMedia[]` (dont l'affiche) + `TicketCategory[]`
   (1 à 4) en une seule transaction Prisma. Les agents de sécurité et le flux d'achat/QR sont
   des sous-systèmes en aval, **hors périmètre**.
2. **Autorisation** : `JwtAuthGuard` + `RolesGuard` exigeant `role === ADMIN`. `createdById` vient
   de `req.user.sub`, jamais du body.
3. **Upload** : le client uploade les fichiers ailleurs (S3/R2) et envoie des **URLs déjà hébergées**
   en JSON. Le backend ne stocke que les métadonnées. Aucun pipeline d'upload côté backend.
4. **Statut initial** : `PENDING_REVIEW` (nouvel état). Validation → `PUBLISHED`. Refus → `REJECTED`.
5. **Modération** : liens magiques dans le mail équipe (JWT signé, anti-rejeu via `UsedToken.jti`).
   Pour éviter une validation accidentelle par préchargement du lien `GET`, le lien ouvre une
   **page de confirmation** qui déclenche un `POST`.
6. **Modèle billets** : QR **unique par billet** (modèle existant `Ticket.qrToken @unique`, scanné/
   invalidé par un agent — en aval). Catégories nommées librement (≤ 4), **stock illimité**
   (`totalStock` nullable), une **image de design par catégorie**.

## Architecture (Approche 1 — module unique, services focalisés)

```
src/events/
├── events.module.ts                 # wiring : Prisma, Mail, JwtModule, AuthModule (JwtAuthGuard)
├── events.controller.ts             # POST /events ; GET /events/moderate ; POST /events/moderate
├── events.service.ts                # createEvent : validation métier + transaction + déclenche le mail
├── event-moderation.service.ts      # génération token modération + moderate(token, decision)
├── dto/
│   ├── create-event.dto.ts          # champs Event + media[] + ticketCategories[] (nested, validés)
│   ├── media-item.dto.ts            # url, fileKey, fileName, mimeType, sizeBytes, mediaType, isPoster
│   ├── ticket-category.dto.ts       # name, price, ticketDesignUrl, maxPerOrder?, benefits?
│   └── moderate.dto.ts              # token, decision
└── entities/event.entity.ts

src/auth/guards/roles.guard.ts        # RolesGuard (lit request.user.role)
src/auth/decorators/roles.decorator.ts# @Roles(...roles)
src/mail/mail.service.ts              # + sendEventModerationEmail(...) + sendEventDecisionEmail(...)
```

`EventsModule` importe `PrismaModule`, `MailModule`, `AuthModule` (pour `JwtAuthGuard` réexporté) et
`JwtModule.register({ secret: process.env.JWT_SECRET })` (pour signer/vérifier les tokens de
modération), suivant le pattern de `UsersModule`. Enregistré dans `AppModule`.

## Modifications du schéma Prisma

```prisma
enum EventStatus {
  DRAFT
  PENDING_REVIEW   // nouveau : en attente de validation par l'équipe
  PUBLISHED
  REJECTED         // nouveau : refusé par l'équipe
  CLOSED
  CANCELLED
}

model Event {
  // ... champs existants ...
  reviewedAt DateTime?   // nouveau : date de la décision de modération
}

model EventMedia {
  // ... champs existants ...
  isPoster Boolean @default(false)  // nouveau : true pour l'affiche (exactement 1 par événement)
}

model TicketCategory {
  // ... champs existants ...
  totalStock      Int?     // MODIFIÉ : nullable → null = stock illimité
  ticketDesignUrl String   // nouveau : URL de l'image de design du billet
}
```

Migration : `npx prisma migrate dev --name event_creation_moderation` puis `npx prisma generate`.

## DTO et validation

### `CreateEventDto` (body de `POST /events`)

Champs client :
- `title: string` — requis, non vide
- `description: string` — requis, non vide
- `startDate: string` (ISO 8601) — requis
- `endDate: string` (ISO 8601) — requis
- `location: string` — requis
- `purchaseDeadline: string` (ISO 8601) — requis
- `category: EventCategory` — requis (enum)
- `gpsLat?: number` / `gpsLng?: number` — optionnels
- `dressCode?: string` — optionnel
- `termsAccepted: boolean` — requis, **doit être `true`** (`@Equals(true)`)
- `media: MediaItemDto[]` — requis, 1 à N, **exactement un** `isPoster === true`
- `ticketCategories: TicketCategoryDto[]` — requis, **1 à 4**

Fixé serveur (jamais le client) : `createdById ← req.user.sub`, `status ← PENDING_REVIEW`, `createdAt`.

### `MediaItemDto`
`url: string` (URL), `fileKey: string`, `fileName: string`, `mimeType: string`,
`sizeBytes: number` (≥ 0), `mediaType: MediaType` (enum), `isPoster: boolean`.

### `TicketCategoryDto`
`name: string` (non vide), `price: number` (≥ 0), `ticketDesignUrl: string` (URL),
`maxPerOrder?: number` (≥ 1, défaut 10), `benefits?: string`.

### `ModerateDto` (body de `POST /events/moderate`)
`token: string` (non vide), `decision: 'approve' | 'reject'` (`@IsIn(['approve','reject'])`).

Validation nested via `@ValidateNested({ each: true })` + `@Type(() => ...)` (le `ValidationPipe`
global a déjà `whitelist`, `forbidNonWhitelisted`, `transform`).

## Règles métier (dans `EventsService.createEvent`)

1. `startDate` doit être dans le futur (> maintenant).
2. `endDate` > `startDate`.
3. `purchaseDeadline` ≤ `startDate`.
4. `termsAccepted === true` (double sécurité avec le DTO).
5. `media` contient **exactement un** poster (`isPoster === true`).
6. `ticketCategories` : 1 à 4 éléments.

Toute violation → `BadRequestException` (messages en français, comme le reste du code).
Création en `$transaction` : `Event` (status `PENDING_REVIEW`) + `EventMedia[]` + `TicketCategory[]`.

Après commit : `EventModerationService.generateModerationToken(eventId)` puis
`MailService.sendEventModerationEmail(...)`. Réponse HTTP :
`{ message: "Votre événement a été soumis à validation. L'équipe Vybe vous informera de sa décision.", eventId, status: 'PENDING_REVIEW' }`.

## Flux de modération

### Génération (à la création)
`EventModerationService.generateModerationToken(eventId)` →
`jwtService.sign({ sub: eventId, type: 'event-moderation', jti: randomUUID() }, { expiresIn: '7d' })`.

### Mail équipe
`MailService.sendEventModerationEmail(event, posterUrl, ticketCategories, approveUrl, rejectUrl)` —
destinataire `VYBE_TEAM_EMAIL` (fallback `SENDGRID_FROM_EMAIL`). Réutilise le template sombre/dégradé
existant. Affiche **toutes** les données : affiche (image), titre, description, dates début/fin, lieu
(+ GPS si présents), catégorie, dress code, date limite d'achat, créateur (id/email), et la liste des
catégories de billets (nom, prix, design). Deux boutons :
- ✅ Valider → `{API_BASE_URL}/events/moderate?token=<jwt>&decision=approve`
- ❌ Refuser → `{API_BASE_URL}/events/moderate?token=<jwt>&decision=reject`

### Endpoints
- `GET /events/moderate?token=&decision=` (public) → renvoie une **page HTML de confirmation**
  minimaliste avec un bouton qui `POST` le même `token`+`decision` (évite la validation par
  préchargement du lien).
- `POST /events/moderate` (public, body `ModerateDto`) → `EventModerationService.moderate(token, decision)`.

### `EventModerationService.moderate(token, decision)`
1. `jwtService.verify(token)` ; sinon `UnauthorizedException('Lien de modération invalide ou expiré.')`.
2. `payload.type === 'event-moderation'` sinon `ForbiddenException`.
3. `jti` absent de `UsedToken` (sinon `ConflictException('Cet événement a déjà été modéré.')`).
4. Charger l'événement (`payload.sub`) ; s'il est absent → `NotFoundException` ; si son statut n'est
   plus `PENDING_REVIEW` → `ConflictException('Cet événement a déjà été modéré.')`.
5. `$transaction` : `Event.update` (`status = PUBLISHED | REJECTED`, `reviewedAt = now`) +
   `UsedToken.create({ jti })`.
6. Notifier le créateur par email (`MailService.sendEventDecisionEmail`) **si** il a un email
   (sinon on n'envoie rien — pas de SMS dans ce périmètre).
7. Retourner un message de confirmation.

## Variables d'environnement (nouvelles)

- `VYBE_TEAM_EMAIL` — destinataire du mail de modération (fallback `SENDGRID_FROM_EMAIL`).
- `API_BASE_URL` — base des liens magiques (ex. `https://api.vybe.app`).

## Tests

- `events.service.spec.ts` — règles métier (dates, terms, poster unique, 1–4 catégories), structure de
  la transaction, déclenchement du mail (mocks Prisma/Mail/Moderation).
- `event-moderation.service.spec.ts` — token invalide/expiré, mauvais type, jti déjà utilisé, statut
  déjà modéré, approve→PUBLISHED, reject→REJECTED, notification créateur.
- `roles.guard.spec.ts` — autorise ADMIN, refuse les autres rôles / absence de user.

## Hors périmètre (specs ultérieures)

- Pipeline d'upload backend (S3/R2) si un jour le backend doit recevoir les fichiers.
- Flux d'achat / commande / génération des QR par billet.
- Création et affectation des agents de sécurité, scan/invalidation des QR.
- Purge automatique, édition d'événement, dashboard admin de modération.
