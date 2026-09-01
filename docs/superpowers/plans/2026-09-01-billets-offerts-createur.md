# Plan d'implémentation — Billets offerts par le créateur

> **Pour les workers agentiques :** SOUS-SKILL REQUISE — utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans pour exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**Goal :** Permettre au créateur d'un événement d'émettre des billets offerts (gratuits, plafonnés à 10/catégorie, consommant le stock, exclus du calcul financier), avec un onglet « Tickets offerts » et un bloc dédié au dashboard.

**Architecture :** Un billet offert = une `Order` `paymentStatus=GIFT` (montants 0) + ses `Ticket`. Nouveau service `GiftService` (module orders) pour l'émission, exposé via `GiftsController` sur `POST /events/:reference/gifts`. `MyTicketsService` gagne l'onglet offerts + le marquage « téléchargé ». `AgentService.getScanDashboard` gagne un bloc `gifts`. Le filtre `paymentStatus='PAID'` déjà en place exclut automatiquement les offerts des finances.

**Tech Stack :** NestJS, Prisma (Postgres/Neon), Jest (specs unitaires mockant Prisma), class-validator.

## Global Constraints

- Français dans les commentaires et messages d'erreur.
- Commits git SANS `Co-Authored-By` (règle projet).
- Rester sur la branche `feat/agent-creation-login-scanTicket` (l'utilisateur pousse lui-même).
- **NE PAS lancer `npx prisma format`** (reformate tout le schéma → annule des diffs volontaires).
- **Base Neon partagée = piège `migrate dev`** : la génération du client (`prisma generate`) ne touche PAS la base et suffit aux specs (Prisma mocké). L'application réelle de la migration (`migrate dev`) est laissée à l'utilisateur (voir Task 1).
- Plafond métier : **10 billets offerts par catégorie**. Éligibilité : forfait illimité (`event.totalCapacity === null`) toujours OK ; forfait limité seulement si `event.totalCapacity > 50`.
- Le `qrToken` brut ne sort JAMAIS d'une réponse de liste/émission.

---

### Task 1 : Schéma Prisma (enum GIFT, giftDownloadedAt, giftedCount) + constante

**Files:**
- Modify: `prisma/schema.prisma` (enum `PaymentStatus`, model `Ticket`, model `TicketCategory`)
- Modify: `src/common/constants.ts`

**Interfaces:**
- Produces : `PaymentStatus.GIFT` (valeur d'enum Prisma) ; `Ticket.giftDownloadedAt: Date | null` ; `TicketCategory.giftedCount: number` ; `MAX_GIFTS_PER_CATEGORY = 10`.

- [ ] **Step 1 : Ajouter `GIFT` à l'enum `PaymentStatus`**

Dans `prisma/schema.prisma`, remplacer le bloc enum par :

```prisma
enum PaymentStatus {
  PENDING
  PAID
  FAILED
  REFUNDED
  GIFT // billet offert par le créateur : montants 0, exclu du calcul financier (≠ PAID)
}
```

- [ ] **Step 2 : Ajouter `giftDownloadedAt` au model `Ticket`**

Dans `model Ticket`, sous la ligne `cancelledAt ...`, ajouter :

```prisma
  giftDownloadedAt DateTime? // billets offerts : horodaté au 1er téléchargement → disparition définitive de l'onglet offerts
```

- [ ] **Step 3 : Ajouter `giftedCount` au model `TicketCategory`**

Dans `model TicketCategory`, sous la ligne `soldCount ...`, ajouter :

```prisma
  giftedCount  Int     @default(0) // compteur des billets offerts émis (≤ 10) ; alimente le compteur X/10 de la carte et le bloc gifts du dashboard
```

- [ ] **Step 4 : Ajouter la constante métier**

Dans `src/common/constants.ts`, à la fin de la section « Billetterie / commandes » (après `PLATFORM_FEE_RATE`), ajouter :

```typescript
// Nombre maximum de billets qu'un créateur peut OFFRIR par catégorie. Le
// frontend applique la même limite (compteur X/10 + désactivation du bouton).
export const MAX_GIFTS_PER_CATEGORY = 10;
```

- [ ] **Step 5 : Régénérer le client Prisma (sans toucher la base)**

Run : `npx prisma generate`
Expected : « Generated Prisma Client » sans erreur (les nouveaux champs/enum apparaissent dans les types).

- [ ] **Step 6 : Vérifier que le projet compile toujours**

Run : `npm run build`
Expected : build OK (aucune référence cassée).

- [ ] **Step 7 : Commit**

```bash
git add prisma/schema.prisma src/common/constants.ts
git commit -m "feat(billets-offerts): schéma GIFT + giftDownloadedAt + giftedCount + constante"
```

- [ ] **Step 8 : (Utilisateur) créer et appliquer la migration**

⚠️ Base Neon partagée : NE PAS lancer aveuglément. Quand l'utilisateur est prêt :
Run : `npx prisma migrate dev --name billets_offerts_gift`
Expected : migration créée dans `prisma/migrations/` et appliquée. Committer le dossier de migration ensuite.

---

### Task 2 : Émission des billets offerts (GiftService + route)

**Files:**
- Create: `src/orders/dto/CreateGift.dto.ts`
- Create: `src/orders/Gift.service.ts`
- Create: `src/orders/Gifts.controller.ts`
- Modify: `src/orders/Order.module.ts`
- Test: `src/orders/Gift.service.spec.ts`

**Interfaces:**
- Consumes : `MAX_GIFTS_PER_CATEGORY` (Task 1), `PrismaService`.
- Produces : `GiftService.emitGifts(userId: string, reference: string, dto: CreateGiftDto): Promise<{ orderId: string; tickets: { id: string }[] }>` ; `CreateGiftDto { ticketCategoryId: string; quantity: number }` ; route `POST /events/:reference/gifts` (JwtAuthGuard + RolesGuard, `@Roles('USER')`).

- [ ] **Step 1 : Écrire le DTO**

Créer `src/orders/dto/CreateGift.dto.ts` :

```typescript
import { IsUUID, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_GIFTS_PER_CATEGORY } from 'src/common/constants';

// Émission de billets offerts pour UNE catégorie. quantity bornée à 10 côté DTO ;
// le plafond réel (cumul déjà offert) est vérifié dans le service.
export class CreateGiftDto {
  @IsUUID('4', { message: 'Catégorie de billet invalide.' })
  ticketCategoryId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_GIFTS_PER_CATEGORY)
  quantity: number;
}
```

- [ ] **Step 2 : Écrire les tests d'émission (échouent d'abord)**

Créer `src/orders/Gift.service.spec.ts` :

```typescript
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GiftService } from './Gift.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('GiftService', () => {
  let service: GiftService;
  let tx: { $executeRaw: jest.Mock; order: { create: jest.Mock }; ticket: { createMany: jest.Mock } };
  let prisma: {
    event: { findUnique: jest.Mock };
    ticketCategory: { findFirst: jest.Mock };
    ticket: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      order: { create: jest.fn().mockResolvedValue({ id: 'gift-order-1' }) },
      ticket: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      event: { findUnique: jest.fn() },
      ticketCategory: { findFirst: jest.fn() },
      ticket: { findMany: jest.fn().mockResolvedValue([{ id: 'tk-1' }, { id: 'tk-2' }]) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    service = new GiftService(prisma as unknown as PrismaService);
  });

  const event = (over: Partial<any> = {}) => ({
    id: 'ev-1',
    reference: 'VYBE-8JGBLV',
    createdById: 'owner',
    totalCapacity: null, // illimité par défaut
    endDate: new Date(Date.now() + 7_200_000),
    ...over,
  });
  const category = (over: Partial<any> = {}) => ({
    id: 'cat-1', eventId: 'ev-1', name: 'Standard', giftedCount: 0, totalStock: null, soldCount: 0, ...over,
  });
  const dto = (over: Partial<any> = {}) => ({ ticketCategoryId: 'cat-1', quantity: 2, ...over });

  it('événement introuvable → 404, pas de transaction', async () => {
    prisma.event.findUnique.mockResolvedValue(null);
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('non-créateur → 403, pas de transaction', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    await expect(service.emitGifts('intrus', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('forfait limité ≤ 50 → 403', async () => {
    prisma.event.findUnique.mockResolvedValue(event({ totalCapacity: 50 }));
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('forfait limité > 50 → autorisé', async () => {
    prisma.event.findUnique.mockResolvedValue(event({ totalCapacity: 51 }));
    prisma.ticketCategory.findFirst.mockResolvedValue(category({ totalStock: 51 }));
    const res = await service.emitGifts('owner', 'VYBE-8JGBLV', dto());
    expect(res.orderId).toBe('gift-order-1');
  });

  it('catégorie hors événement / introuvable → 404', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(null);
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cumul > 10 (pré-check) → 400', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(category({ giftedCount: 9 }));
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto({ quantity: 2 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('succès illimité → crée une Order GIFT (montants 0) + N tickets', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(category());
    const res = await service.emitGifts('owner', 'VYBE-8JGBLV', dto({ quantity: 2 }));
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'owner', ticketCategoryId: 'cat-1', quantity: 2,
          unitPrice: 0, totalAmount: 0, platformFee: 0, organizerAmount: 0, paymentStatus: 'GIFT',
        }),
      }),
    );
    const ticketsArg = tx.ticket.createMany.mock.calls[0][0].data;
    expect(ticketsArg).toHaveLength(2);
    expect(res).toEqual({ orderId: 'gift-order-1', tickets: [{ id: 'tk-1' }, { id: 'tk-2' }] });
  });

  it('UPDATE gardé renvoie 0 (plafond/stock concurrent) → 409', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(category({ totalStock: 100 }));
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(ConflictException);
  });
});
```

- [ ] **Step 3 : Lancer les tests (échec attendu)**

Run : `npx jest src/orders/Gift.service.spec.ts`
Expected : FAIL — `Cannot find module './Gift.service'`.

- [ ] **Step 4 : Écrire le service**

Créer `src/orders/Gift.service.ts` :

```typescript
import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { MAX_GIFTS_PER_CATEGORY } from 'src/common/constants';
import { CreateGiftDto } from './dto/CreateGift.dto';

@Injectable()
export class GiftService {
  constructor(private readonly prisma: PrismaService) {}

  // Émission de billets OFFERTS par le créateur pour son propre événement.
  // Gratuits (montants 0), plafonnés à MAX_GIFTS_PER_CATEGORY par catégorie,
  // consomment le stock (soldCount) et sont exclus du calcul financier (paymentStatus GIFT ≠ PAID).
  async emitGifts(userId: string, reference: string, dto: CreateGiftDto) {
    const event = await this.prisma.event.findUnique({ where: { reference } });
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.createdById !== userId) {
      throw new ForbiddenException('Vous ne gérez pas cet événement.');
    }
    // Éligibilité : illimité (totalCapacity null) toujours OK ; limité seulement si > 50.
    if (event.totalCapacity !== null && event.totalCapacity <= 50) {
      throw new ForbiddenException(
        "L'offre de billets nécessite un forfait illimité ou un forfait limité de plus de 50 billets.",
      );
    }
    const category = await this.prisma.ticketCategory.findFirst({
      where: { id: dto.ticketCategoryId, eventId: event.id },
    });
    if (!category) throw new NotFoundException('Catégorie de billet introuvable.');
    // Pré-check plafond (message clair) ; l'UPDATE gardé ci-dessous reste l'autorité anti-course.
    if (category.giftedCount + dto.quantity > MAX_GIFTS_PER_CATEGORY) {
      throw new BadRequestException(
        `Vous ne pouvez offrir que ${MAX_GIFTS_PER_CATEGORY} billets pour « ${category.name} » (déjà ${category.giftedCount} offert(s)).`,
      );
    }

    const orderId = await this.prisma.$transaction(async (tx) => {
      // Réservation atomique : plafond des 10 ET anti-survente en un seul UPDATE gardé.
      const affected = await tx.$executeRaw`
        UPDATE "TicketCategory"
        SET "soldCount" = "soldCount" + ${dto.quantity},
            "giftedCount" = "giftedCount" + ${dto.quantity}
        WHERE "id" = ${dto.ticketCategoryId}
        AND "giftedCount" + ${dto.quantity} <= ${MAX_GIFTS_PER_CATEGORY}
        AND ("totalStock" IS NULL OR "soldCount" + ${dto.quantity} <= "totalStock")`;
      if (affected === 0) {
        throw new ConflictException(`Émission impossible : plafond ou stock atteint (${category.name}).`);
      }
      const order = await tx.order.create({
        data: {
          userId,
          ticketCategoryId: dto.ticketCategoryId,
          quantity: dto.quantity,
          unitPrice: 0, totalAmount: 0, platformFee: 0, organizerAmount: 0,
          paymentStatus: 'GIFT',
        },
      });
      const tickets = Array.from({ length: dto.quantity }, () => ({
        orderId: order.id,
        ticketCategoryId: dto.ticketCategoryId,
        qrToken: randomUUID(),
        expiresAt: event.endDate,
      }));
      await tx.ticket.createMany({ data: tickets });
      return order.id;
    });

    const tickets = await this.prisma.ticket.findMany({
      where: { orderId },
      select: { id: true },
    });
    return { orderId, tickets };
  }
}
```

- [ ] **Step 5 : Lancer les tests (succès attendu)**

Run : `npx jest src/orders/Gift.service.spec.ts`
Expected : PASS (tous les cas).

- [ ] **Step 6 : Écrire le contrôleur**

Créer `src/orders/Gifts.controller.ts` :

```typescript
import { Controller, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { GiftService } from './Gift.service';
import { CreateGiftDto } from './dto/CreateGift.dto';

// Pas de préfixe : chemin complet events/:reference/gifts (cohérent avec les
// routes créateur du module agent). Deux segments → aucun conflit avec events/:id.
@Controller()
export class GiftsController {
  constructor(private readonly giftService: GiftService) {}

  // Émettre des billets offerts pour un événement (organisateur uniquement).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Post('events/:reference/gifts')
  async emit(@Req() req, @Param('reference') reference: string, @Body() dto: CreateGiftDto) {
    return this.giftService.emitGifts(req.user.sub, reference, dto);
  }
}
```

- [ ] **Step 7 : Enregistrer dans le module orders**

Dans `src/orders/Order.module.ts`, ajouter les imports et les entrées `controllers`/`providers` :

```typescript
import { GiftService } from './Gift.service';
import { GiftsController } from './Gifts.controller';
```

puis dans le décorateur `@Module` :
- `controllers: [OrdersController, MyTicketsController, GiftsController]`
- `providers: [OrderService, MyTicketsService, GiftService]`

- [ ] **Step 8 : Vérifier build + suite ciblée**

Run : `npm run build && npx jest src/orders`
Expected : build OK, specs orders PASS.

- [ ] **Step 9 : Commit**

```bash
git add src/orders/dto/CreateGift.dto.ts src/orders/Gift.service.ts src/orders/Gifts.controller.ts src/orders/Gift.service.spec.ts src/orders/Order.module.ts
git commit -m "feat(billets-offerts): émission POST /events/:reference/gifts (GiftService)"
```

---

### Task 3 : Onglet « Tickets offerts » + exclusion des onglets normaux

**Files:**
- Modify: `src/orders/MyTickets.service.ts` (`fetchRows` : exclure GIFT ; nouvelle méthode `getMyGifts`)
- Modify: `src/orders/dto/MyTickets.dto.ts` (type de réponse offerts)
- Modify: `src/orders/MyTickets.controller.ts` (route `GET /me/tickets/gifts`)
- Test: `src/orders/MyTickets.service.spec.ts`

**Interfaces:**
- Consumes : `MyEventTicketsDto`, `groupByEvent` (privé, réutilisé).
- Produces : `MyTicketsService.getMyGifts(userId: string): Promise<{ events: MyEventTicketsDto[] }>` ; route `GET /me/tickets/gifts`.

- [ ] **Step 1 : Écrire les tests (échouent d'abord)**

Ajouter à la fin du `describe('MyTicketsService', …)` dans `src/orders/MyTickets.service.spec.ts` :

```typescript
  describe('getMyGifts', () => {
    it('billets normaux exclus des onglets upcoming/past (filtre paymentStatus != GIFT)', async () => {
      await service.getMyTickets('user-1');
      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where.order).toEqual({ userId: 'user-1', paymentStatus: { not: 'GIFT' } });
    });

    it('offerts visibles : UNUSED + giftDownloadedAt null, groupés par événement', async () => {
      prisma.ticket.findMany.mockResolvedValueOnce([row({ id: 'g1', categoryName: 'Standard' })]);
      const res = await service.getMyGifts('user-1');
      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where).toEqual(
        expect.objectContaining({
          order: { userId: 'user-1', paymentStatus: 'GIFT' },
          qrStatus: 'UNUSED',
          giftDownloadedAt: null,
        }),
      );
      expect(res.events).toHaveLength(1);
      expect(res.events[0].tickets[0].id).toBe('g1');
    });

    it('aucun offert visible → { events: [] }', async () => {
      prisma.ticket.findMany.mockResolvedValueOnce([]);
      const res = await service.getMyGifts('user-1');
      expect(res).toEqual({ events: [] });
    });
  });
```

- [ ] **Step 2 : Lancer les tests (échec attendu)**

Run : `npx jest src/orders/MyTickets.service.spec.ts -t getMyGifts`
Expected : FAIL — `service.getMyGifts is not a function` et l'assertion sur `where.order` (encore `{ userId }`).

- [ ] **Step 3 : Exclure les GIFT des onglets normaux**

Dans `src/orders/MyTickets.service.ts`, méthode `fetchRows`, remplacer dans le `where` :

```typescript
        order: { userId },
```
par :
```typescript
        // Les billets offerts ont leur propre onglet (getMyGifts) : jamais dans upcoming/past.
        order: { userId, paymentStatus: { not: 'GIFT' } },
```

- [ ] **Step 4 : Ajouter la méthode `getMyGifts`**

Dans `src/orders/MyTickets.service.ts`, ajouter cette méthode dans la classe (après `getMyTickets`) :

```typescript
  // Onglet « Tickets offerts » : billets GIFT du user, VISIBLES uniquement tant
  // qu'ils sont UNUSED ET pas encore téléchargés (giftDownloadedAt null). Une fois
  // téléchargés ou scannés, ils disparaissent définitivement (pas de flou, disparition totale).
  async getMyGifts(userId: string): Promise<{ events: MyEventTicketsDto[] }> {
    const rows = await this.prisma.ticket.findMany({
      where: {
        order: { userId, paymentStatus: 'GIFT' },
        qrStatus: QRStatus.UNUSED,
        giftDownloadedAt: null,
      },
      orderBy: [
        { ticketCategory: { event: { startDate: 'asc' } } },
        { createdAt: 'asc' },
      ],
      select: {
        id: true,
        qrStatus: true,
        expiresAt: true,
        cancelledAt: true,
        ticketCategory: {
          select: {
            name: true,
            ticketDesignUrl: true,
            event: {
              select: {
                id: true, reference: true, title: true, category: true,
                startDate: true, endDate: true, location: true,
                mediaFiles: { where: { isPoster: true }, take: 1, select: { url: true } },
              },
            },
          },
        },
      },
    });
    return { events: this.groupByEvent(rows) };
  }
```

- [ ] **Step 5 : Ajouter le type de réponse (documentation du contrat)**

Dans `src/orders/dto/MyTickets.dto.ts`, ajouter à la fin :

```typescript
// Réponse de GET /me/tickets/gifts : billets offerts encore visibles, groupés par événement.
export interface MyGiftsResponseDto {
  events: MyEventTicketsDto[];
}
```

- [ ] **Step 6 : Lancer les tests (succès attendu)**

Run : `npx jest src/orders/MyTickets.service.spec.ts`
Expected : PASS (dont les anciens tests toujours verts).

- [ ] **Step 7 : Exposer la route**

Dans `src/orders/MyTickets.controller.ts`, ajouter la route (avant `tickets/:id/qr-token` pour rester lisible ; `gifts` est un segment statique, aucun conflit avec `:id`) :

```typescript
  // GET /me/tickets/gifts — billets offerts encore visibles (UNUSED + non téléchargés).
  @Get('tickets/gifts')
  async myGifts(@Req() req) {
    return this.myTicketsService.getMyGifts(req.user.sub);
  }
```

- [ ] **Step 8 : Vérifier build + specs orders**

Run : `npm run build && npx jest src/orders`
Expected : build OK, specs PASS.

- [ ] **Step 9 : Commit**

```bash
git add src/orders/MyTickets.service.ts src/orders/MyTickets.controller.ts src/orders/dto/MyTickets.dto.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(billets-offerts): onglet GET /me/tickets/gifts + exclusion des onglets normaux"
```

---

### Task 4 : Disparition au téléchargement (marquage giftDownloadedAt)

**Files:**
- Modify: `src/orders/MyTickets.service.ts` (`getTicketForRender` expose le statut ; nouvelle méthode `markGiftDownloaded`)
- Modify: `src/orders/MyTickets.controller.ts` (marquer après rendu si GIFT)
- Test: `src/orders/MyTickets.service.spec.ts`

**Interfaces:**
- Consumes : `getTicketForRender` (existant, à enrichir).
- Produces : `MyTicketsService.markGiftDownloaded(userId: string, ticketId: string): Promise<void>` ; `getTicketForRender` renvoie désormais aussi `order: { paymentStatus }`.

- [ ] **Step 1 : Écrire les tests (échouent d'abord)**

Ajouter dans `src/orders/MyTickets.service.spec.ts` un nouveau describe :

```typescript
  describe('markGiftDownloaded', () => {
    it('pose giftDownloadedAt uniquement sur un GIFT non encore téléchargé du propriétaire', async () => {
      prisma.ticket.updateMany = jest.fn().mockResolvedValue({ count: 1 });
      await service.markGiftDownloaded('user-1', 'g1');
      const args = prisma.ticket.updateMany.mock.calls[0][0];
      expect(args.where).toEqual({
        id: 'g1',
        order: { userId: 'user-1', paymentStatus: 'GIFT' },
        giftDownloadedAt: null,
      });
      expect(args.data.giftDownloadedAt).toBeInstanceOf(Date);
    });
  });
```

Note : `prisma.ticket` du beforeEach n'expose que `findMany`/`findFirst` — le test ci-dessus ajoute `updateMany` à la volée, c'est suffisant.

- [ ] **Step 2 : Lancer les tests (échec attendu)**

Run : `npx jest src/orders/MyTickets.service.spec.ts -t markGiftDownloaded`
Expected : FAIL — `service.markGiftDownloaded is not a function`.

- [ ] **Step 3 : Enrichir `getTicketForRender` + ajouter `markGiftDownloaded`**

Dans `src/orders/MyTickets.service.ts`, dans le `select` de `getTicketForRender`, ajouter `order` :

```typescript
            select: {
                qrToken: true,
                order: { select: { paymentStatus: true } },
                ticketCategory: {
```
(le reste du select inchangé).

Puis ajouter la méthode (après `getTicketForRender`) :

```typescript
  // Marque un billet OFFERT comme téléchargé (disparition définitive de l'onglet).
  // updateMany gardé : ne touche que le billet GIFT du propriétaire encore non
  // téléchargé → idempotent, no-op sur un billet normal ou déjà marqué.
  async markGiftDownloaded(userId: string, ticketId: string): Promise<void> {
    await this.prisma.ticket.updateMany({
      where: { id: ticketId, order: { userId, paymentStatus: 'GIFT' }, giftDownloadedAt: null },
      data: { giftDownloadedAt: new Date() },
    });
  }
```

- [ ] **Step 4 : Lancer les tests (succès attendu)**

Run : `npx jest src/orders/MyTickets.service.spec.ts`
Expected : PASS.

- [ ] **Step 5 : Câbler le marquage dans le contrôleur download**

Dans `src/orders/MyTickets.controller.ts`, méthode `download`, juste avant `res.end(buffer);`, ajouter :

```typescript
    // Billet offert : premier téléchargement → disparition définitive de l'onglet offerts.
    if (t.order.paymentStatus === 'GIFT') {
      await this.myTicketsService.markGiftDownloaded(req.user.sub, id);
    }
```

- [ ] **Step 6 : Vérifier build + specs orders**

Run : `npm run build && npx jest src/orders`
Expected : build OK, specs PASS.

- [ ] **Step 7 : Commit**

```bash
git add src/orders/MyTickets.service.ts src/orders/MyTickets.controller.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(billets-offerts): disparition définitive au téléchargement (giftDownloadedAt)"
```

---

### Task 5 : Dashboard — bloc `gifts` + `gifted` par catégorie

**Files:**
- Modify: `src/agent/dto/ScanDashboard.dto.ts` (champ `gifted` + bloc `gifts`)
- Modify: `src/agent/agent.service.ts` (`getScanDashboard`)
- Test: `src/agent/agent.service.spec.ts`

**Interfaces:**
- Consumes : `getScanDashboard` (existant).
- Produces : `ScanDashboardResponseDto.byCategory[].gifted: number` ; `ScanDashboardResponseDto.gifts: { total: number; byCategory: { name: string; count: number }[] }`.

- [ ] **Step 1 : Écrire les tests (échouent d'abord)**

Dans `src/agent/agent.service.spec.ts`, dans le test « agrège totaux, catégories, agents et taux d'entrée » (~ligne 300), enrichir le mock `ticketCategory.findMany` avec `giftedCount` :

```typescript
      prisma.ticketCategory.findMany.mockResolvedValue([
        { id: 'c1', name: 'VIP', soldCount: 5, totalStock: 10, giftedCount: 2 },
        { id: 'c2', name: 'Standard', soldCount: 4, totalStock: null, giftedCount: 0 },
      ]);
```

puis, après les assertions `byCategory` existantes, ajouter :

```typescript
      expect(res.byCategory[0]).toEqual(
        expect.objectContaining({ name: 'VIP', gifted: 2 }),
      );
      expect(res.gifts).toEqual({
        total: 2,
        byCategory: [
          { name: 'VIP', count: 2 },
          { name: 'Standard', count: 0 },
        ],
      });
```

- [ ] **Step 2 : Lancer les tests (échec attendu)**

Run : `npx jest src/agent/agent.service.spec.ts -t "agrège totaux"`
Expected : FAIL — `res.gifts` est `undefined`, `byCategory[0].gifted` absent.

- [ ] **Step 3 : Mettre à jour le DTO**

Dans `src/agent/dto/ScanDashboard.dto.ts` :
- dans l'item `byCategory`, ajouter après `revenue`:

```typescript
        gifted: number;   // billets OFFERTS de la catégorie (giftedCount), inclus dans sold
```
- avant la fermeture de l'interface (après `finances { … }`), ajouter :

```typescript
    // Espace « offerts gratuitement » : comptage des billets offerts, séparé du
    // calcul financier (les GIFT ne sont jamais des ventes PAID).
    gifts: {
        total: number;
        byCategory: { name: string; count: number }[];
    };
```

- [ ] **Step 4 : Mettre à jour le service**

Dans `src/agent/agent.service.ts`, méthode `getScanDashboard` :

1. Étendre le `select` de `ticketCategory.findMany` (bloc « 2. Par catégorie ») avec `giftedCount` :

```typescript
      select: { id: true, name: true, soldCount: true, totalStock: true, giftedCount: true },
```

2. Dans le `map` `byCategory`, ajouter le champ `gifted` :

```typescript
      return {
        name: c.name,
        sold: c.soldCount,
        scanned: catScanned,
        remaining: c.totalStock === null ? null : c.totalStock - c.soldCount,
        awaitingCheckIn: c.soldCount - catScanned,
        revenue: revenueForCat(c.id),
        gifted: c.giftedCount,
      };
```

3. Juste avant la construction de l'objet `finances`, calculer le bloc `gifts` :

```typescript
    // Bloc offerts : lecture directe de giftedCount (aucune agrégation de tickets).
    const gifts = {
      total: categories.reduce((acc, c) => acc + c.giftedCount, 0),
      byCategory: categories.map((c) => ({ name: c.name, count: c.giftedCount })),
    };
```

4. Ajouter `gifts` à l'objet retourné (après `finances`) :

```typescript
    return {
      event: { reference: event.reference, title: event.title },
      totals: { total, scanned, unused, cancelled, entryRate, capacity },
      byCategory,
      byAgent,
      timeline,
      finances,
      gifts,
    };
```

- [ ] **Step 5 : Lancer les tests (succès attendu)**

Run : `npx jest src/agent/agent.service.spec.ts`
Expected : PASS (tous les tests dashboard, finances inchangées car le filtre `paymentStatus='PAID'` exclut nativement les GIFT).

- [ ] **Step 6 : Vérifier build**

Run : `npm run build`
Expected : build OK.

- [ ] **Step 7 : Commit**

```bash
git add src/agent/dto/ScanDashboard.dto.ts src/agent/agent.service.ts src/agent/agent.service.spec.ts
git commit -m "feat(billets-offerts): dashboard bloc gifts + gifted par catégorie"
```

---

### Task 6 : Garde du contrat de la carte (createdById + giftedCount exposés)

**Files:**
- Test: `src/events/events.service.spec.ts`

**Interfaces:**
- Consumes : `EventsService.findOne` (existant, inchangé) ; `findPublished` (existant).

Contexte : `findOne` et `findPublished` renvoient l'événement complet (aucun `select` restrictif) avec `include: { ticketCategories: true }` → `createdById` (scalaire de Event) et `giftedCount` (scalaire de TicketCategory) sont exposés **automatiquement**. Cette tâche ajoute un test de GARDE pour qu'un futur `select` ne casse pas silencieusement la carte créateur. Aucune modification de code de production.

- [ ] **Step 1 : Écrire le test de garde**

Dans `src/events/events.service.spec.ts`, ajouter un describe (adapter le nom du mock prisma/service à celui déjà utilisé dans ce fichier ; le service est instancié avec `prisma`, `mailService`, `moderationService`) :

```typescript
  describe('contrat carte (createdById + giftedCount)', () => {
    it('findOne renvoie createdById et giftedCount par catégorie', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'ev-1', reference: 'VYBE-AAA', createdById: 'owner',
        mediaFiles: [], createdBy: { id: 'owner' },
        ticketCategories: [{ id: 'c1', name: 'Standard', giftedCount: 3 }],
      });
      const res: any = await service.findOne('ev-1');
      expect(res.createdById).toBe('owner');
      expect(res.ticketCategories[0].giftedCount).toBe(3);
      // Garde-fou : findOne doit inclure les catégories (pas de select restrictif).
      const args = prisma.event.findUnique.mock.calls[0][0];
      expect(args.include.ticketCategories).toBeTruthy();
    });
  });
```

Note : reprendre le nom exact du mock (`prisma`) et de la variable `service` déjà présents en haut de ce fichier ; si `prisma.event.findUnique` n'est pas encore mocké dans ce describe, l'ajouter au `beforeEach` local ou dans le test.

- [ ] **Step 2 : Lancer le test**

Run : `npx jest src/events/events.service.spec.ts -t "contrat carte"`
Expected : PASS (le code de prod expose déjà ces champs).

- [ ] **Step 3 : Commit**

```bash
git add src/events/events.service.spec.ts
git commit -m "test(billets-offerts): garde contrat carte (createdById + giftedCount)"
```

---

### Task 7 : Vérification globale

- [ ] **Step 1 : Suite complète**

Run : `npm run test`
Expected : toutes les suites vertes (les nouvelles specs incluses).

- [ ] **Step 2 : Lint + build**

Run : `npm run lint && npm run build`
Expected : aucun nouvel avertissement bloquant, build OK.

- [ ] **Step 3 : Rappel migration (utilisateur)**

Si non fait en Task 1 Step 8 : appliquer `npx prisma migrate dev --name billets_offerts_gift` sur la base de la branche (⚠️ Neon partagée), committer le dossier de migration, puis pousser la branche.

---

## Récap des endpoints livrés

- `POST /events/:reference/gifts` — émettre des billets offerts (créateur, `{ ticketCategoryId, quantity }`).
- `GET /me/tickets/gifts` — onglet des billets offerts encore visibles.
- `GET /me/tickets/:id/download` — inchangé côté appelant, mais marque désormais un billet offert comme téléchargé (disparition).
- `GET /events/:reference/scan-dashboard` — enrichi (`byCategory[].gifted`, bloc `gifts`).
- `GET /events/:id` & `GET /events` — exposent `createdById` + `giftedCount` (déjà le cas ; garde ajoutée).

## Front (hors périmètre de ce plan backend)

Carte créateur : bandeau organisateur ; par catégorie bouton « Offrir un ticket » + sélecteur de quantité (1 à `10 - giftedCount`) + compteur `giftedCount/10` (offerts/max) ; bouton « Dashboard » à la place d'« Acheter ». Voir le design doc `docs/superpowers/specs/2026-09-01-billets-offerts-createur-design.md`.
