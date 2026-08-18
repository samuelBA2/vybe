# Brique C — `GET /me/tickets` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exposer `GET /me/tickets` : la liste des billets de l'utilisateur authentifié, groupée par événement et séparée en `upcoming` / `past`.

**Architecture:** Un `MyTicketsController` dédié (`@Controller('me')`, `@Get('tickets')`) délègue à un `MyTicketsService.getMyTickets(userId)`. Le service charge tous les billets de l'utilisateur via Prisma, filtre les annulés selon la règle des 24h, groupe par événement, découpe upcoming/past et trie — toute la logique en JS pour être testable unitairement. Ajout d'un champ `Ticket.cancelledAt` au schéma (lu ici, écrit par une brique future).

**Tech Stack:** NestJS, TypeScript, Prisma (Postgres/Neon), Jest.

## Global Constraints

- Commentaires et messages en **français**.
- Imports absolus `src/...` (résolus par `moduleNameMapper` en test).
- Enums Prisma importés via `import { $Enums } from '@prisma/client'`.
- Pas de `Co-Authored-By` dans les messages de commit.
- Tests service : instancier le service réel avec un Prisma **mocké** (pas de `TestingModule`), suivant le style de `src/orders/Order.service.spec.ts`.
- Le `qrToken` brut n'est **jamais** exposé dans la réponse.
- Base Neon **partagée entre branches** : `prisma migrate dev` est un piège (ledger de migrations commun). La migration DB est exécutée **par l'utilisateur**, pas automatiquement.

---

## File Structure

- `prisma/schema.prisma` — ajout du champ `Ticket.cancelledAt`.
- `src/orders/dto/MyTickets.dto.ts` (créé) — interfaces de la réponse (`MyTicketsResponseDto`, `MyEventTicketsDto`, `MyTicketDto`).
- `src/orders/MyTickets.service.ts` (créé) — logique de lecture/groupement.
- `src/orders/MyTickets.service.spec.ts` (créé) — tests unitaires du service.
- `src/orders/MyTickets.controller.ts` (créé) — route `GET /me/tickets`.
- `src/orders/Order.module.ts` (modifié) — enregistre le contrôleur et le service.

---

## Task 1: Schéma — champ `Ticket.cancelledAt`

**Files:**
- Modify: `prisma/schema.prisma` (model `Ticket`, ~ligne 239-257)

**Interfaces:**
- Consumes: rien.
- Produces: le champ `cancelledAt: Date | null` sur le type Prisma `Ticket`, lu par la Task 2.

- [ ] **Step 1: Ajouter le champ au model `Ticket`**

Dans `prisma/schema.prisma`, dans `model Ticket`, ajouter après `scannedByAgentId` :

```prisma
  cancelledAt      DateTime? // posé au passage en CANCELLED (brique d'annulation future) ; lu par GET /me/tickets pour la règle des 24h
```

- [ ] **Step 2: Régénérer le client Prisma (local, sans DB)**

Run: `npx prisma generate`
Expected: `Generated Prisma Client` — le type `Ticket` expose désormais `cancelledAt`.

- [ ] **Step 3: Créer la migration DB — À EXÉCUTER PAR L'UTILISATEUR**

⚠️ Base Neon partagée : ne pas lancer automatiquement. L'utilisateur exécute lui-même, sur la base de sa branche :

```bash
npx prisma migrate dev --name ticket_cancelled_at
```

La migration attendue est un simple `ALTER TABLE "Ticket" ADD COLUMN "cancelledAt" TIMESTAMP(3);` (colonne nullable, aucune donnée existante impactée).

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(tickets): champ Ticket.cancelledAt pour la règle des 24h"
```

---

## Task 2: `MyTicketsService` (logique + tests)

**Files:**
- Create: `src/orders/dto/MyTickets.dto.ts`
- Create: `src/orders/MyTickets.service.ts`
- Test: `src/orders/MyTickets.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService` (`prisma.ticket.findMany`), champ `Ticket.cancelledAt` (Task 1).
- Produces:
  - `MyTicketsService.getMyTickets(userId: string): Promise<MyTicketsResponseDto>`
  - `MyTicketsResponseDto = { upcoming: MyEventTicketsDto[]; past: MyEventTicketsDto[] }`
  - `MyEventTicketsDto = { event: { id, reference, title, startDate: Date, endDate: Date, location, posterUrl: string | null }, tickets: MyTicketDto[] }`
  - `MyTicketDto = { id, categoryName, qrStatus: $Enums.QRStatus, ticketImageUrl: string | null, pdfUrl: string | null, expiresAt: Date, cancelledAt: Date | null }`

- [ ] **Step 1: Écrire les interfaces de réponse**

Créer `src/orders/dto/MyTickets.dto.ts` :

```typescript
import { $Enums } from '@prisma/client';

// Un billet individuel tel que renvoyé au propriétaire (jamais le qrToken brut).
export interface MyTicketDto {
  id: string;
  categoryName: string;
  qrStatus: $Enums.QRStatus;
  ticketImageUrl: string | null; // PNG (design + QR) ; null si génération échouée
  pdfUrl: string | null;         // PDF ; null si génération échouée
  expiresAt: Date;
  cancelledAt: Date | null;
}

// Un événement + les billets que l'utilisateur y possède.
export interface MyEventTicketsDto {
  event: {
    id: string;
    reference: string;
    title: string;
    startDate: Date;
    endDate: Date;
    location: string;
    posterUrl: string | null; // EventMedia isPoster ; null si absent
  };
  tickets: MyTicketDto[];
}

// Réponse de GET /me/tickets : deux groupes, à venir et passés.
export interface MyTicketsResponseDto {
  upcoming: MyEventTicketsDto[];
  past: MyEventTicketsDto[];
}
```

- [ ] **Step 2: Écrire les tests (qui échouent)**

Créer `src/orders/MyTickets.service.spec.ts` :

```typescript
import { MyTicketsService } from './MyTickets.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('MyTicketsService', () => {
  let service: MyTicketsService;
  let prisma: { ticket: { findMany: jest.Mock } };

  beforeEach(() => {
    prisma = { ticket: { findMany: jest.fn() } };
    service = new MyTicketsService(prisma as unknown as PrismaService);
  });

  const HOUR = 3_600_000;
  const now = Date.now();

  // Fabrique une ligne Ticket telle que renvoyée par findMany (relations incluses).
  const row = (over: any = {}) => ({
    id: over.id ?? 't1',
    qrStatus: over.qrStatus ?? 'UNUSED',
    ticketImageUrl: over.ticketImageUrl ?? 'png-url',
    pdfUrl: over.pdfUrl ?? 'pdf-url',
    expiresAt: over.expiresAt ?? new Date(now + 48 * HOUR),
    cancelledAt: over.cancelledAt ?? null,
    ticketCategory: {
      name: over.categoryName ?? 'VIP',
      event: {
        id: over.eventId ?? 'ev-future',
        reference: over.reference ?? 'VYBE-AAA',
        title: over.title ?? 'Soirée',
        startDate: over.startDate ?? new Date(now + 24 * HOUR),
        endDate: over.endDate ?? new Date(now + 30 * HOUR),
        location: over.location ?? 'Paris',
        mediaFiles: over.mediaFiles ?? [{ url: 'poster-url' }],
      },
    },
  });

  it('utilisateur sans billet → { upcoming: [], past: [] }', async () => {
    prisma.ticket.findMany.mockResolvedValue([]);
    const res = await service.getMyTickets('user-1');
    expect(res).toEqual({ upcoming: [], past: [] });
    // Ne charge que les billets de cet utilisateur.
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { order: { userId: 'user-1' } } }),
    );
  });

  it('plusieurs billets du même événement → une entrée, tous les billets dedans', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 't1', eventId: 'ev-1' }),
      row({ id: 't2', eventId: 'ev-1' }),
      row({ id: 't3', eventId: 'ev-1' }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming).toHaveLength(1);
    expect(res.upcoming[0].tickets.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('mappe les champs billet (pas de qrToken) et posterUrl', async () => {
    prisma.ticket.findMany.mockResolvedValue([row({ id: 't1' })]);
    const res = await service.getMyTickets('user-1');
    const evt = res.upcoming[0];
    expect(evt.event.posterUrl).toBe('poster-url');
    expect(evt.tickets[0]).toEqual({
      id: 't1',
      categoryName: 'VIP',
      qrStatus: 'UNUSED',
      ticketImageUrl: 'png-url',
      pdfUrl: 'pdf-url',
      expiresAt: expect.any(Date),
      cancelledAt: null,
    });
    expect(evt.tickets[0]).not.toHaveProperty('qrToken');
  });

  it('split upcoming/past selon endDate vs now', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 'fut', eventId: 'ev-fut', endDate: new Date(now + 5 * HOUR) }),
      row({ id: 'pas', eventId: 'ev-pas', endDate: new Date(now - 5 * HOUR), startDate: new Date(now - 10 * HOUR) }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming.map((e) => e.event.id)).toEqual(['ev-fut']);
    expect(res.past.map((e) => e.event.id)).toEqual(['ev-pas']);
  });

  it('trie upcoming croissant (le plus proche d\'abord) et past décroissant', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 'u-late', eventId: 'u-late', startDate: new Date(now + 20 * HOUR), endDate: new Date(now + 21 * HOUR) }),
      row({ id: 'u-soon', eventId: 'u-soon', startDate: new Date(now + 2 * HOUR), endDate: new Date(now + 3 * HOUR) }),
      row({ id: 'p-old', eventId: 'p-old', startDate: new Date(now - 40 * HOUR), endDate: new Date(now - 39 * HOUR) }),
      row({ id: 'p-recent', eventId: 'p-recent', startDate: new Date(now - 5 * HOUR), endDate: new Date(now - 4 * HOUR) }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming.map((e) => e.event.id)).toEqual(['u-soon', 'u-late']);
    expect(res.past.map((e) => e.event.id)).toEqual(['p-recent', 'p-old']);
  });

  it('annulé il y a 23h → visible ; 25h → masqué ; CANCELLED sans date → masqué', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 'keep-unused', eventId: 'ev-1', qrStatus: 'UNUSED' }),
      row({ id: 'keep-23h', eventId: 'ev-1', qrStatus: 'CANCELLED', cancelledAt: new Date(now - 23 * HOUR) }),
      row({ id: 'drop-25h', eventId: 'ev-1', qrStatus: 'CANCELLED', cancelledAt: new Date(now - 25 * HOUR) }),
      row({ id: 'drop-null', eventId: 'ev-1', qrStatus: 'CANCELLED', cancelledAt: null }),
    ]);
    const res = await service.getMyTickets('user-1');
    const ids = res.upcoming[0].tickets.map((t) => t.id);
    expect(ids).toContain('keep-unused');
    expect(ids).toContain('keep-23h');
    expect(ids).not.toContain('drop-25h');
    expect(ids).not.toContain('drop-null');
  });

  it('poster absent → posterUrl null ; visuels non générés → urls null', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 't1', mediaFiles: [], ticketImageUrl: null, pdfUrl: null }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming[0].event.posterUrl).toBeNull();
    expect(res.upcoming[0].tickets[0].ticketImageUrl).toBeNull();
    expect(res.upcoming[0].tickets[0].pdfUrl).toBeNull();
  });
});
```

- [ ] **Step 3: Lancer les tests → ils échouent**

Run: `npx jest src/orders/MyTickets.service.spec.ts`
Expected: FAIL — `Cannot find module './MyTickets.service'`.

- [ ] **Step 4: Écrire le service**

Créer `src/orders/MyTickets.service.ts` :

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MyTicketsResponseDto,
  MyEventTicketsDto,
} from './dto/MyTickets.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MyTicketsService {
  constructor(private readonly prisma: PrismaService) {}

  // Renvoie les billets de l'utilisateur, groupés par événement et séparés
  // en événements à venir (upcoming) et passés (past).
  async getMyTickets(userId: string): Promise<MyTicketsResponseDto> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - DAY_MS); // annulés visibles < 24h

    const rows = await this.prisma.ticket.findMany({
      where: { order: { userId } },
      include: {
        ticketCategory: {
          include: {
            event: {
              include: {
                // On ne récupère que l'affiche.
                mediaFiles: { where: { isPoster: true }, take: 1 },
              },
            },
          },
        },
      },
    });

    // Règle des 24h : on masque les billets annulés depuis plus de 24h,
    // ainsi que les CANCELLED sans date d'annulation.
    const kept = rows.filter(
      (t) =>
        t.qrStatus !== 'CANCELLED' ||
        (t.cancelledAt != null && t.cancelledAt >= cutoff),
    );

    // Regroupement par événement (une carte par événement).
    const byEvent = new Map<string, MyEventTicketsDto>();
    for (const t of kept) {
      const ev = t.ticketCategory.event;
      let entry = byEvent.get(ev.id);
      if (!entry) {
        entry = {
          event: {
            id: ev.id,
            reference: ev.reference,
            title: ev.title,
            startDate: ev.startDate,
            endDate: ev.endDate,
            location: ev.location,
            posterUrl: ev.mediaFiles[0]?.url ?? null,
          },
          tickets: [],
        };
        byEvent.set(ev.id, entry);
      }
      entry.tickets.push({
        id: t.id,
        categoryName: t.ticketCategory.name,
        qrStatus: t.qrStatus,
        ticketImageUrl: t.ticketImageUrl ?? null,
        pdfUrl: t.pdfUrl ?? null,
        expiresAt: t.expiresAt,
        cancelledAt: t.cancelledAt ?? null,
      });
    }

    const groups = [...byEvent.values()];
    const upcoming = groups
      .filter((g) => g.event.endDate >= now)
      .sort((a, b) => a.event.startDate.getTime() - b.event.startDate.getTime());
    const past = groups
      .filter((g) => g.event.endDate < now)
      .sort((a, b) => b.event.startDate.getTime() - a.event.startDate.getTime());

    return { upcoming, past };
  }
}
```

- [ ] **Step 5: Lancer les tests → ils passent**

Run: `npx jest src/orders/MyTickets.service.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/orders/dto/MyTickets.dto.ts src/orders/MyTickets.service.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(tickets): MyTicketsService — lecture groupée des billets (brique C)"
```

---

## Task 3: `MyTicketsController` + câblage module

**Files:**
- Create: `src/orders/MyTickets.controller.ts`
- Test: `src/orders/MyTickets.controller.spec.ts`
- Modify: `src/orders/Order.module.ts`

**Interfaces:**
- Consumes: `MyTicketsService.getMyTickets` (Task 2), `JwtAuthGuard`, `RolesGuard`, `Roles`.
- Produces: route `GET /me/tickets`.

- [ ] **Step 1: Écrire le test contrôleur (qui échoue)**

Créer `src/orders/MyTickets.controller.spec.ts` (style des specs contrôleur du repo : service mocké, gardes neutralisées) :

```typescript
import { Test } from '@nestjs/testing';
import { MyTicketsController } from './MyTickets.controller';
import { MyTicketsService } from './MyTickets.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';

describe('MyTicketsController', () => {
  let controller: MyTicketsController;
  const svc = { getMyTickets: jest.fn().mockResolvedValue({ upcoming: [], past: [] }) };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MyTicketsController],
      providers: [{ provide: MyTicketsService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(MyTicketsController);
  });

  it('délègue à getMyTickets avec req.user.sub', async () => {
    const res = await controller.myTickets({ user: { sub: 'user-1' } } as any);
    expect(svc.getMyTickets).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ upcoming: [], past: [] });
  });
});
```

- [ ] **Step 2: Lancer le test → il échoue**

Run: `npx jest src/orders/MyTickets.controller.spec.ts`
Expected: FAIL — `Cannot find module './MyTickets.controller'`.

- [ ] **Step 3: Écrire le contrôleur**

Créer `src/orders/MyTickets.controller.ts` :

```typescript
import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { MyTicketsService } from './MyTickets.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
@Controller('me')
export class MyTicketsController {
  constructor(private readonly myTicketsService: MyTicketsService) {}

  // GET /me/tickets — billets de l'utilisateur, groupés par événement.
  @Get('tickets')
  async myTickets(@Req() req) {
    return this.myTicketsService.getMyTickets(req.user.sub);
  }
}
```

- [ ] **Step 4: Câbler le module**

Dans `src/orders/Order.module.ts`, ajouter le contrôleur et le service :

```typescript
import { Module } from "@nestjs/common";
import { OrderService } from "./Order.service";
import { OrdersController } from "./CreateOrder.controller";
import { PrismaModule } from "src/prisma/prisma.module";
import { AuthModule } from "src/auth/auth.module";
import { TicketAssetModule } from "src/ticket-asset/ticket-asset.module";
import { MyTicketsController } from "./MyTickets.controller";
import { MyTicketsService } from "./MyTickets.service";

@Module({
    imports: [PrismaModule, AuthModule, TicketAssetModule],
    controllers: [OrdersController, MyTicketsController],
    providers: [OrderService, MyTicketsService]
})
export class OrderModule{}
```

- [ ] **Step 5: Lancer le test contrôleur → il passe**

Run: `npx jest src/orders/MyTickets.controller.spec.ts`
Expected: PASS.

- [ ] **Step 6: Lancer toute la suite + le build**

Run: `npm test && npm run build`
Expected: suite verte (nouvelles specs incluses), build sans erreur TypeScript.

- [ ] **Step 7: Commit**

```bash
git add src/orders/MyTickets.controller.ts src/orders/MyTickets.controller.spec.ts src/orders/Order.module.ts
git commit -m "feat(tickets): route GET /me/tickets (brique C)"
```

---

## Notes de vérification manuelle (optionnel, après implémentation)

Avec un serveur lancé (`npm run start:dev`) et un JWT de session valide :

```bash
curl -H "Authorization: Bearer <token>" http://localhost:3000/me/tickets
```

Attendu : `{ "upcoming": [...], "past": [...] }`, chaque événement avec son `posterUrl` et ses billets (chacun avec `ticketImageUrl` + `pdfUrl`), sans aucun `qrToken`.
