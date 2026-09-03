# Notifications (backend) — Plan d'implémentation

> **Pour les workers agentiques :** SOUS-SKILL REQUISE — utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**Goal :** Persister et exposer de vraies notifications in-app pour le créateur d'un événement, déclenchées à la soumission (`EVENT_SUBMITTED`) et à la décision de modération (`EVENT_PUBLISHED` / `EVENT_REJECTED`), avec suivi lu/non-lu.

**Architecture :** Nouveau modèle Prisma `Notification` (+ enum `NotificationType`) relié à `User`. Nouveau `NotificationsModule` (service + controller `@Controller('me')`) exposant `GET /me/notifications`, `GET /me/notifications/unread-count`, `PATCH /me/notifications/:id/read`. Déclencheurs : `EventsService.createEvent` (notif de soumission, non bloquante) et `EventModerationService.moderate` (notif de décision, créée dans le `$transaction` existant). Textes FR centralisés dans le module notifications.

**Tech Stack :** NestJS, Prisma (Postgres/Neon), Jest (specs mockant Prisma).

## Global Constraints

- Français dans les commentaires et messages. Commits git SANS `Co-Authored-By`.
- Branche `feat/notifications` (déjà créée depuis `main` à jour). L'utilisateur pousse lui-même.
- **NE PAS lancer `npx prisma format`** ni `migrate dev`/`deploy` (base Neon partagée) : seule `npx prisma generate` est autorisée (types). La migration réelle est laissée à l'utilisateur (Task 1, dernière étape).
- Destinataire = **le créateur uniquement**. Pas de diffusion.
- Déclencheurs non bloquants : un échec de création de notif ne doit JAMAIS faire échouer la création/modération d'événement (même principe que l'envoi d'e-mail déjà en place).
- Contrat d'API figé : `GET /me/notifications` → `NotificationDto[]` ; `GET /me/notifications/unread-count` → `{ count: number }` ; `PATCH /me/notifications/:id/read` → `{ ok: true }`. `NotificationDto = { id, type, title, body, eventId: string | null, read: boolean, createdAt: Date }`.
- Textes FR exacts (voir Task 2, `notification-text.ts`).

---

### Task 1 : Modèle Prisma `Notification` + enum + relation User

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces : enum `NotificationType { EVENT_SUBMITTED, EVENT_PUBLISHED, EVENT_REJECTED }` ; model `Notification { id, userId, user, type, title, body, eventId?, read, createdAt }` avec `@@index([userId, read])` et `@@index([userId, createdAt])` ; back-relation `User.notifications`.

- [ ] **Step 1 : Ajouter l'enum + le modèle**

Dans `prisma/schema.prisma`, après le model `UsedToken` (vers la ligne 59), ajouter :

```prisma
enum NotificationType {
  EVENT_SUBMITTED
  EVENT_PUBLISHED
  EVENT_REJECTED
}

// Notification in-app d'un utilisateur. Texte rendu (title/body en français) stocké
// directement ; le `type` sert au frontend pour choisir l'icône/dégradé. eventId permet
// le lien « Voir l'événement ». read = suivi lu/non-lu (badge cloche + mise en évidence).
model Notification {
  id        String           @id @default(uuid())
  userId    String
  user      User             @relation(fields: [userId], references: [id])
  type      NotificationType
  title     String
  body      String
  eventId   String?
  read      Boolean          @default(false)
  createdAt DateTime         @default(now())

  @@index([userId, read])       // compteur des non-lues
  @@index([userId, createdAt])  // liste chronologique
}
```

- [ ] **Step 2 : Ajouter la back-relation sur `User`**

Dans `model User`, sous la ligne `orders Order[]` (vers la ligne 33), ajouter :

```prisma
  notifications Notification[]
```

- [ ] **Step 3 : Régénérer le client Prisma (sans toucher la base)**

Run : `npx prisma generate`
Expected : « Generated Prisma Client » sans erreur (les types `Notification`/`NotificationType` apparaissent).

- [ ] **Step 4 : Vérifier la compilation**

Run : `npm run build`
Expected : build OK.

- [ ] **Step 5 : Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat(notifications): modèle Prisma Notification + enum + relation User"
```

- [ ] **Step 6 : (Utilisateur) créer et appliquer la migration**

⚠️ Base Neon partagée : NE PAS lancer soi-même. Quand l'utilisateur est prêt :
Run : `npx prisma migrate dev --name notifications`
puis committer le dossier `prisma/migrations/`.

---

### Task 2 : NotificationsService + module + controller + endpoints

**Files:**
- Create: `src/notifications/notification-text.ts`
- Create: `src/notifications/dto/notification.dto.ts`
- Create: `src/notifications/notifications.service.ts`
- Create: `src/notifications/notifications.controller.ts`
- Create: `src/notifications/notifications.module.ts`
- Modify: `src/app.module.ts` (enregistrer `NotificationsModule`)
- Test: `src/notifications/notifications.service.spec.ts`

**Interfaces:**
- Consumes : `PrismaService`, `JwtAuthGuard` (via `AuthModule`).
- Produces :
  - `notificationText.{eventSubmitted,eventPublished,eventRejected}(title): { title: string; body: string }`
  - `NotificationsService.create(userId, type, title, body, eventId?): Promise<void>`
  - `NotificationsService.listForUser(userId): Promise<NotificationDto[]>`
  - `NotificationsService.unreadCount(userId): Promise<{ count: number }>`
  - `NotificationsService.markRead(userId, id): Promise<{ ok: true }>`
  - `NotificationsModule` (exporte `NotificationsService`)
  - Routes `GET /me/notifications`, `GET /me/notifications/unread-count`, `PATCH /me/notifications/:id/read`.

- [ ] **Step 1 : Textes FR centralisés**

Créer `src/notifications/notification-text.ts` :

```typescript
// Textes rendus (français) des notifications, centralisés pour rester cohérents
// entre le déclencheur de soumission (EventsService) et celui de décision
// (EventModerationService).
export const notificationText = {
  eventSubmitted: (eventTitle: string) => ({
    title: `« ${eventTitle} » soumis à validation`,
    body: "Ton événement est en cours de modération. On te prévient dès qu'il est validé.",
  }),
  eventPublished: (eventTitle: string) => ({
    title: `« ${eventTitle} » est publié 🎉`,
    body: 'Ton événement est en ligne, les participants peuvent réserver leurs billets.',
  }),
  eventRejected: (eventTitle: string) => ({
    title: `« ${eventTitle} » n'a pas été validé`,
    body: "Ton événement n'a pas passé la modération. Contacte l'équipe Vybe pour en savoir plus.",
  }),
};
```

- [ ] **Step 2 : DTO de réponse**

Créer `src/notifications/dto/notification.dto.ts` :

```typescript
import { $Enums } from '@prisma/client';

// Forme exposée au client (jamais userId). type → icône/dégradé côté frontend.
export interface NotificationDto {
  id: string;
  type: $Enums.NotificationType;
  title: string;
  body: string;
  eventId: string | null;
  read: boolean;
  createdAt: Date;
}
```

- [ ] **Step 3 : Écrire les tests du service (RED)**

Créer `src/notifications/notifications.service.spec.ts` :

```typescript
import { NotificationsService } from './notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new NotificationsService(prisma as unknown as PrismaService);
  });

  it('create insère une notif pour le user', async () => {
    await service.create('u1', 'EVENT_SUBMITTED', 'T', 'B', 'e1');
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: { userId: 'u1', type: 'EVENT_SUBMITTED', title: 'T', body: 'B', eventId: 'e1' },
    });
  });

  it('listForUser : tri createdAt desc, filtre userId, plafonné, projette le DTO', async () => {
    prisma.notification.findMany.mockResolvedValue([
      { id: 'n1', type: 'EVENT_PUBLISHED', title: 'T', body: 'B', eventId: 'e1', read: false, createdAt: new Date(0) },
    ]);
    const res = await service.listForUser('u1');
    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'u1' });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.take).toBeGreaterThan(0);
    expect(res).toEqual([
      { id: 'n1', type: 'EVENT_PUBLISHED', title: 'T', body: 'B', eventId: 'e1', read: false, createdAt: new Date(0) },
    ]);
  });

  it('unreadCount : compte les non-lues du user', async () => {
    prisma.notification.count.mockResolvedValue(3);
    const res = await service.unreadCount('u1');
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId: 'u1', read: false } });
    expect(res).toEqual({ count: 3 });
  });

  it('markRead : gardé par userId + read=false (ownership, idempotent)', async () => {
    const res = await service.markRead('u1', 'n1');
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', userId: 'u1', read: false },
      data: { read: true },
    });
    expect(res).toEqual({ ok: true });
  });
});
```

Run : `npx jest src/notifications/notifications.service.spec.ts`
Expected : FAIL (`Cannot find module './notifications.service'`).

- [ ] **Step 4 : Implémenter le service**

Créer `src/notifications/notifications.service.ts` :

```typescript
import { Injectable } from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationDto } from './dto/notification.dto';

// Plafond de sécurité (pas une pagination) : borne le volume chargé. Un utilisateur
// réel n'atteint jamais cette valeur en v1.
const MAX_NOTIFICATIONS = 100;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // Helper appelé par les déclencheurs (soumission/décision). Le texte est déjà rendu.
  async create(
    userId: string,
    type: $Enums.NotificationType,
    title: string,
    body: string,
    eventId?: string,
  ): Promise<void> {
    await this.prisma.notification.create({
      data: { userId, type, title, body, eventId },
    });
  }

  async listForUser(userId: string): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: MAX_NOTIFICATIONS,
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        eventId: true,
        read: true,
        createdAt: true,
      },
    });
    return rows;
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }

  // Ownership + idempotent : ne touche que la notif non lue de CE user. Aucune
  // distinction 403/404 (pas de fuite d'existence). No-op si déjà lue ou pas à soi.
  async markRead(userId: string, id: string): Promise<{ ok: true }> {
    await this.prisma.notification.updateMany({
      where: { id, userId, read: false },
      data: { read: true },
    });
    return { ok: true };
  }
}
```

Run : `npx jest src/notifications/notifications.service.spec.ts`
Expected : PASS (4/4).

- [ ] **Step 5 : Implémenter le controller**

Créer `src/notifications/notifications.controller.ts` :

```typescript
import { Controller, Get, Patch, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@UseGuards(JwtAuthGuard)
@Controller('me')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // Liste des notifications de l'utilisateur connecté (plus récentes d'abord).
  @Get('notifications')
  async list(@Req() req) {
    return this.notifications.listForUser(req.user.sub);
  }

  // Compteur des non-lues (badge chiffré de la cloche).
  @Get('notifications/unread-count')
  async unreadCount(@Req() req) {
    return this.notifications.unreadCount(req.user.sub);
  }

  // Marque une notification comme lue (propriétaire uniquement, idempotent).
  @Patch('notifications/:id/read')
  async markRead(@Req() req, @Param('id') id: string) {
    return this.notifications.markRead(req.user.sub, id);
  }
}
```

- [ ] **Step 6 : Implémenter le module**

Créer `src/notifications/notifications.module.ts` :

```typescript
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [PrismaModule, AuthModule], // AuthModule fournit JwtAuthGuard
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService], // consommé par EventsModule (déclencheurs)
})
export class NotificationsModule {}
```

- [ ] **Step 7 : Enregistrer dans `app.module.ts`**

Dans `src/app.module.ts` : ajouter l'import
```typescript
import { NotificationsModule } from './notifications/notifications.module';
```
et ajouter `NotificationsModule` à la liste `imports` du `@Module` (après `OrderModule`).

- [ ] **Step 8 : Vérifier build + specs ciblées**

Run : `npm run build && npx jest src/notifications`
Expected : build OK, specs PASS.

- [ ] **Step 9 : Commit**

```bash
git add src/notifications src/app.module.ts
git commit -m "feat(notifications): service + endpoints /me/notifications (+ unread-count, mark read)"
```

---

### Task 3 : Déclencheurs (soumission + décision)

**Files:**
- Modify: `src/events/events.module.ts` (importer `NotificationsModule`)
- Modify: `src/events/events.service.ts` (notif de soumission)
- Modify: `src/events/event-moderation.service.ts` (notif de décision, dans la transaction)
- Test: `src/events/events.service.spec.ts`, `src/events/event-moderation.service.spec.ts`

**Interfaces:**
- Consumes : `NotificationsService.create` (Task 2), `notificationText` (Task 2), `tx.notification.create` (Prisma, dans `moderate`).

- [ ] **Step 1 : Importer NotificationsModule dans EventsModule**

Dans `src/events/events.module.ts` : ajouter l'import
```typescript
import { NotificationsModule } from '../notifications/notifications.module';
```
et ajouter `NotificationsModule` à la liste `imports` du `@Module`.

- [ ] **Step 2 : Injecter NotificationsService dans EventsService + notif de soumission (test RED d'abord)**

Dans `src/events/events.service.spec.ts`, le `beforeEach` (ligne ~48) instancie
`new EventsService(prisma, mail, moderation)`. Il faut ajouter un 4e argument mocké.
Ajouter au mock un `notifications = { create: jest.fn().mockResolvedValue(undefined) }` et le
passer au constructeur : `new EventsService(prisma, mail, moderation, notifications)`. Puis
ajouter un test :

```typescript
  it('crée une notification de soumission au créateur (non bloquante)', async () => {
    await service.createEvent('user-1', baseDto());
    expect(notifications.create).toHaveBeenCalledWith(
      'user-1',
      'EVENT_SUBMITTED',
      expect.stringContaining('soumis'),
      expect.any(String),
      'evt-1',
    );
  });
```
(NB : le mock `prisma.event.create` renvoie déjà `{ id: 'evt-1', ... }` dans ce fichier.)

⚠️ Il y a DEUX `describe`/`beforeEach` dans ce fichier (ligne 48 et 181) qui instancient
`EventsService` — mettre à jour LES DEUX constructeurs pour ajouter le 4e argument, sinon le 2e
bloc casse.

Run : `npx jest src/events/events.service.spec.ts`
Expected : FAIL (le constructeur n'accepte pas encore le 4e arg / `notifications.create` non appelé).

- [ ] **Step 3 : Implémenter la notif de soumission**

Dans `src/events/events.service.ts` (ce fichier utilise les imports absolus `src/...`) :
- Importer :
  ```typescript
  import { NotificationsService } from 'src/notifications/notifications.service';
  import { notificationText } from 'src/notifications/notification-text';
  ```
- Ajouter au constructeur le paramètre : `private readonly notifications: NotificationsService,` (après `moderationService`).
- Juste après le bloc d'envoi d'e-mail de modération (après le `try/catch` du `sendWithRetry`, avant le `return`), ajouter :

```typescript
    // Notification in-app de soumission (non bloquante : un échec ne compromet pas
    // la création déjà persistée, comme pour l'e-mail).
    try {
      const t = notificationText.eventSubmitted(dto.title);
      await this.notifications.create(userId, 'EVENT_SUBMITTED', t.title, t.body, event.id);
    } catch (err) {
      this.logger.error(
        `Échec de création de la notification de soumission pour l'événement ${event.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
```

Run : `npx jest src/events/events.service.spec.ts`
Expected : PASS.

- [ ] **Step 4 : Notif de décision dans la modération (test RED d'abord)**

Dans `src/events/event-moderation.service.spec.ts`, le test d'approbation vérifie déjà le
`$transaction`. Le mock du client `tx` doit exposer `notification: { create: jest.fn() }`.
Localiser la construction du `tx` mock (objet passé au callback de `$transaction`) et y ajouter
`notification: { create: jest.fn() }`. Puis, dans le test « approuve », ajouter :

```typescript
    expect(tx.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner',            // = event.createdBy.id du mock
        type: 'EVENT_PUBLISHED',
        eventId: expect.any(String),
      }),
    });
```
Adapter `'owner'` à la valeur de `createdBy.id` réellement utilisée dans le mock de ce fichier
(lire le fichier pour la valeur exacte). Ajouter un test symétrique pour le rejet (`type: 'EVENT_REJECTED'`).

Run : `npx jest src/events/event-moderation.service.spec.ts`
Expected : FAIL (`tx.notification.create` non appelé).

- [ ] **Step 5 : Implémenter la notif de décision**

Dans `src/events/event-moderation.service.ts` (imports absolus `src/...`) :
- Importer : `import { notificationText } from 'src/notifications/notification-text';`
- Dans le callback du `$transaction` (après `tx.usedToken.create`), ajouter la création de la
  notification, atomique avec le changement de statut :

```typescript
      const t = approved
        ? notificationText.eventPublished(event.title)
        : notificationText.eventRejected(event.title);
      await tx.notification.create({
        data: {
          userId: event.createdById,
          type: approved ? 'EVENT_PUBLISHED' : 'EVENT_REJECTED',
          title: t.title,
          body: t.body,
          eventId: event.id,
        },
      });
```
(NB : `event.createdById` est un scalaire disponible sur l'événement chargé ; `event.createdBy` est
aussi inclus. Utiliser `event.createdById`.)

Run : `npx jest src/events/event-moderation.service.spec.ts`
Expected : PASS.

- [ ] **Step 6 : Vérifier build + suite complète**

Run : `npm run build && npm run test`
Expected : build OK, toute la suite verte.

- [ ] **Step 7 : Commit**

```bash
git add src/events/events.module.ts src/events/events.service.ts src/events/events.service.spec.ts src/events/event-moderation.service.ts src/events/event-moderation.service.spec.ts
git commit -m "feat(notifications): déclencheurs création (soumission) + modération (décision)"
```

---

### Task 4 : Vérification globale

- [ ] **Step 1 : Suite + lint + build**

Run : `npm run test` puis `npm run lint` puis `npm run build`
Expected : tout vert.

- [ ] **Step 2 : Rappel migration (utilisateur)**

Si non fait en Task 1 Step 6 : `npx prisma migrate dev --name notifications` sur la base de la
branche (⚠️ Neon), committer le dossier de migration, puis pousser la branche.

---

## Endpoints livrés
- `GET /me/notifications` → `NotificationDto[]`
- `GET /me/notifications/unread-count` → `{ count }`
- `PATCH /me/notifications/:id/read` → `{ ok: true }`
- Déclencheurs : soumission d'événement → `EVENT_SUBMITTED` ; modération → `EVENT_PUBLISHED`/`EVENT_REJECTED`.

## Suite (hors périmètre de ce plan)
Frontend : `notifications.service` + `use-notifications` + `Notifications.tsx` branché + badge chiffré `BottomNav` — plan séparé côté `vybeFrontend`, après ce backend. Voir `docs/superpowers/specs/2026-09-03-notifications-createur-design.md`.
