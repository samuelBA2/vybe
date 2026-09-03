# Notifications réelles (créateur) — Design

Date : 2026-09-03
Repos : backend `/Users/user/vybe` (NestJS + Prisma) ; frontend `/Users/user/vybeFrontend` (React + Vite + TanStack Query)
Remplace : le mock `DEMO_NOTIFICATIONS` de `Notifications.tsx`.

## Objectif

Remplacer les notifications factices par de vraies notifications persistées, déclenchées par le
cycle de vie d'un événement, et affichées avec **exactement le même style que le mock** (cartes à
tuile-icône dégradée, titre + horodatage, corps, lien « Voir l'événement », état vide honnête).

## Périmètre (v1) — décisions produit

- **Destinataire = le créateur de l'événement uniquement** (aucune diffusion à tous les users).
- **Déclencheurs :**
  1. Soumission d'un événement (statut `PENDING_REVIEW`) → notif `EVENT_SUBMITTED`.
  2. Décision de modération → `EVENT_PUBLISHED` (approuvé) ou `EVENT_REJECTED` (refusé).
- **Lu / non-lu complet.** Marquage **au clic** sur chaque notification (individuel).
- **Cloche** : affiche un **compteur chiffré** des non-lues (ex. « 3 », plafonné « 9+ »), pas un
  simple point. Le compteur disparaît quand tout est lu.
- **In-app uniquement** (pas de push/mobile). Les e-mails existants (modération/décision) restent
  inchangés — la notif s'ajoute à côté, elle ne les remplace pas.

## Modèle de données (Prisma)

```prisma
enum NotificationType {
  EVENT_SUBMITTED
  EVENT_PUBLISHED
  EVENT_REJECTED
}

model Notification {
  id        String           @id @default(uuid())
  userId    String
  user      User             @relation(fields: [userId], references: [id])
  type      NotificationType
  title     String           // texte rendu (FR) — affiché tel quel
  body      String           // texte rendu (FR)
  eventId   String?          // lien « Voir l'événement » → /events/:eventId (null = pas de lien)
  read      Boolean          @default(false)
  createdAt DateTime         @default(now())

  @@index([userId, read])      // compteur des non-lues (badge cloche)
  @@index([userId, createdAt]) // liste chronologique
}
```
Ajout de la back-relation `notifications Notification[]` sur `User`.

Choix clé : le backend stocke un **`type`** (pour le mapping icône/dégradé côté front) **et** les
textes rendus `title`/`body`. Le front ne recalcule pas les textes ; il ne mappe que
`type → { icône, dégradé, présence du lien }`. L'app est mono-langue (français), donc stocker le
texte rendu est le plus simple et colle à la forme du mock (`title`/`body` déjà présents).

Migration Prisma dédiée (ne PAS lancer `prisma format`). `migrate dev` réservé à l'utilisateur.

## Backend

### `NotificationsService` (nouveau module `NotificationsModule`)
- `create(userId, type, title, body, eventId?)` — insère une notif (helper appelé par les
  déclencheurs). Ne throw jamais de façon bloquante côté appelant (voir déclencheurs).
- `listForUser(userId)` — `findMany where userId order by createdAt desc`, avec un plafond de
  sécurité (`take: MAX+1`, même garde-fou que `/me/tickets`, sans pagination réelle en v1).
- `unreadCount(userId)` — `count where userId, read=false`.
- `markRead(userId, id)` — `updateMany where { id, userId, read: false } data { read: true }`.
  Gardé par `userId` (ownership), idempotent, no-op si déjà lue ou pas à soi (aucune fuite
  d'existence : pas de 403/404 distinct).

### `NotificationsController` (`@Controller('me')`, `@UseGuards(JwtAuthGuard)`)
- `GET /me/notifications` → `{ items: NotificationDto[] }` (ou tableau simple ; voir plan).
- `GET /me/notifications/unread-count` → `{ count: number }`.
- `PATCH /me/notifications/:id/read` → `{ ok: true }` (via `markRead(req.user.sub, id)`).

`NotificationsModule` exporte `NotificationsService` ; importé par `EventsModule` pour les
déclencheurs.

### Déclencheurs (non bloquants)
- **`EventsService.createEvent`** : juste après `prisma.event.create`, créer une notif
  `EVENT_SUBMITTED` pour `userId = createur`, dans un `try/catch` (un échec de notif ne doit
  jamais faire échouer la création d'événement — même principe que l'envoi d'e-mail déjà en place).
  `eventId` = l'événement créé.
- **`EventModerationService.moderate`** : créer la notif `EVENT_PUBLISHED`/`EVENT_REJECTED`
  **à l'intérieur du `$transaction`** existant (`tx.notification.create`), pour qu'elle soit
  atomique avec le changement de statut. `userId = event.createdBy.id`, `eventId = event.id`.

### Textes FR (rendus, stockés)
- `EVENT_SUBMITTED` — title : `« {titre} » soumis à validation` · body : `Ton événement est en cours de modération. On te prévient dès qu'il est validé.`
- `EVENT_PUBLISHED` — title : `« {titre} » est publié 🎉` · body : `Ton événement est en ligne, les participants peuvent réserver leurs billets.`
- `EVENT_REJECTED` — title : `« {titre} » n'a pas été validé` · body : `Ton événement n'a pas passé la modération. Contacte l'équipe Vybe pour en savoir plus.`

## Frontend

### Couche données
- `types/api.ts` : `NotificationType = "EVENT_SUBMITTED" | "EVENT_PUBLISHED" | "EVENT_REJECTED"` ;
  `NotificationDto { id, type, title, body, eventId: string | null, read: boolean, createdAt: string }`.
- `notifications.service.ts` : `getMine()`, `getUnreadCount()`, `markRead(id)`.
- `hooks/queries/keys.ts` : `notifications: { mine, unreadCount }`.
- `use-notifications.ts` : `useNotifications(enabled)` ; `useUnreadNotificationsCount(enabled)`
  (`refetchOnWindowFocus` + `refetchInterval` léger ~60 s) ; `useMarkNotificationRead()` (mutation,
  `onSuccess` invalide `notifications.mine` + `notifications.unreadCount`).

### `Notifications.tsx`
- Remplacer `DEMO_NOTIFICATIONS` par `useNotifications(!isGuest)`.
- Conserver la présentation exacte du mock. Ajouter un mapping local
  `TYPE_META: Record<NotificationType, { Icon, tile }>` réutilisant les **dégradés du mock** :
  - `EVENT_SUBMITTED` → icône sablier/horloge, tuile violette (`from-[hsl(270_92%_60%)] to-[hsl(320_95%_65%)]`)
  - `EVENT_PUBLISHED` → icône coche/party, tuile rose (`from-[hsl(300_90%_60%)] to-[hsl(330_90%_62%)]`)
  - `EVENT_REJECTED` → icône alerte, tuile neutre/rouge
- `timeLabel` : temps relatif calculé depuis `createdAt` (helper front, ex. « Il y a 2 h », « Hier »).
- `highlighted = !read`.
- Clic sur la carte (ou sur « Voir l'événement » si `eventId`) → `useMarkNotificationRead().mutate(id)`
  puis `navigate('/events/' + eventId)` si `eventId`.
- Conserver les 3 états (chargement / erreur / vide) — l'état vide existe déjà.

### Cloche (`BottomNav`)
- Câbler le badge aujourd'hui mort : `BottomNav` appelle `useUnreadNotificationsCount()` (seulement
  si authentifié) et affiche un **compteur chiffré** (ex. « 3 », « 9+ » au-delà de 9) sur la cloche
  quand `count > 0`. Garder la prop `hasNotif` optionnelle comme override de test si utile.

## Tests

Backend : `NotificationsService` (create ; list tri desc + plafond ; unreadCount ; markRead
ownership + idempotent) ; déclencheurs (`createEvent` crée une `EVENT_SUBMITTED` non bloquante ;
`moderate` crée `EVENT_PUBLISHED`/`EVENT_REJECTED` dans la transaction) ; garde du controller.
Front : `notifications.service` (URLs + payloads) ; hooks (invalidation) ; `Notifications.tsx`
(4 états, clic = markRead + navigation, highlight des non-lues) ; badge chiffré `BottomNav`.

## Hors périmètre (YAGNI)

- Pas de diffusion à tous les utilisateurs, pas d'abonnement/follow.
- Pas de notifs billets/gift/sécurité (le mock en montrait ; v1 = cycle de vie événement seulement).
  Le modèle `type` reste extensible pour les ajouter plus tard sans refonte.
- Pas de push web/mobile, pas de temps réel (WebSocket) : polling léger suffit.
- Pas de « tout marquer comme lu » global (marquage au clic uniquement).

## Dépendances / séquencement

Backend d'abord (modèle + endpoints + déclencheurs + migration), puis frontend (les écrans mockent
l'API en test, donc le front est implémentable sans backend en ligne, mais ne fonctionne en réel
qu'une fois le backend déployé + migration appliquée).
