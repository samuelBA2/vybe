# Réservation de billets (paiement cash à la porte) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un utilisateur de réserver un billet d'entrée sans payer en ligne et de régler en cash à la porte, via un QR distinct qui, au scan, ouvre un pop-up de recouvrement (Encaisser / Supprimer) au lieu d'un accès direct.

**Architecture (spec §6 bis — table `Reservation` dédiée) :** Une réservation est une entité de **première classe** dans une table dédiée `Reservation` — **ni** `Order` **ni** `Ticket`. Elle porte son propre `qrToken`, ses coordonnées de porteur, et vit tout son cycle de vie dans cette seule ligne (« seul le statut change » : `RESERVED → USED` à l'encaissement, `RESERVED → CANCELLED` à la suppression). Les modèles `Ticket`/`Order`/`PaymentStatus`/`QRStatus` existants **ne sont pas touchés**. Le plafond reste porté par `TicketCategory.reservedCount/reservationCap/reservationEnabled` (décrément atomique conditionnel, pattern `soldCount`). Le cash encaissé est tracé dans un modèle dédié `GateCashCollection`, **hors** ledger IOU (`LedgerEntry`) → soldes/retraits inchangés.

**Tech Stack :** NestJS · Prisma · PostgreSQL (Neon) · Jest (unit, Prisma mocké).

**Périmètre :** Backend uniquement (phases 0–5 + tests). Le frontend (phases 6–7 du spec) sera planifié séparément dans le repo React `/Users/user/vybeFrontend` à partir des contrats d'API résumés en fin de document.

> **Note :** ce plan remplace une version antérieure basée sur `Order(RESERVED)` + `Ticket(RESERVED)`. L'architecture retenue est la **table `Reservation` dédiée** (spec §6 bis), décidée avec l'utilisateur.

## Global Constraints

Ces règles s'appliquent implicitement à **chaque** tâche :

- **Langue :** tout commentaire de code et tout message d'erreur en **français** (convention Vybe).
- **Montants en `Float`**, pas en cents (`TicketCategory.price: Float`, `Currency` USD/CDF). Ignorer les `priceCents` du spec (idéalisés).
- **Catégorie réservable = la catégorie de base (index 0)** d'un événement (« 1ʳᵉ catégorie / catégorie d'entrée »). Réservation interdite sur les catégories spéciales (index ≥ 1).
- **Plafond par défaut = 50** (`RESERVATION_DEFAULT_CAP`), configurable via `TicketCategory.reservationCap`.
- **1 réservation active par compte et par événement**, garantie par l'index unique **partiel** `Reservation (eventId, userId) WHERE status = 'RESERVED'`.
- **Atomicité :** réutiliser le pattern existant — `UPDATE ... WHERE <garde>` via `tx.$executeRaw`, rejet si le nombre de lignes affectées est 0. Jamais de lecture-puis-écriture non protégée.
- **Contact porteur stocké sur `Reservation`, JAMAIS sur `User` :** les champs `holderFirstName/holderLastName/holderPhone` du pop-up vont sur la ligne `Reservation`. Le réservant est un `User` connecté avec son profil, mais le porteur peut différer → on ne met **jamais** à jour `User` depuis le pop-up. Cela permet de faire la différence entre l'identité du compte et le contact de cette réservation (et sert le disclaimer « litige »).
- **Cycle de vie « seul le statut change » (même ligne) :** Encaisser/Supprimer **ne créent aucune nouvelle ligne** ; ils transitent en place `Reservation.status`/`resolution` (même `id`, même `qrToken`, QR mort après). Le montant encaissé est tracé **à part** (`GateCashCollection`), jamais « dans » la ligne `Reservation`.
- **Base Neon partagée (piège connu) :** migration **créée et commitée** mais appliquée délibérément. Ne pas lancer `prisma migrate dev` à l'aveugle sur une base partagée ; voir la note de la Tâche 1.
- **Lint :** `npm run lint` applique `eslint --fix` (reformate en masse) — vérifier plutôt avec `npx eslint <fichier>` sans `--fix`.
- **Commits :** fréquents, un par tâche. **Ne pas committer sans que l'utilisateur le demande** — proposer le commit à la fin de chaque tâche. Pas de ligne `Co-Authored-By` (règle CLAUDE.md).

---

## File Structure

**Créés :**
- `src/reservations/reservations.module.ts` — module de réservation.
- `src/reservations/reservations.service.ts` — création atomique + état « réservation active ».
- `src/reservations/reservations.controller.ts` — `POST /reservations`, `GET /reservations/active`.
- `src/reservations/dto/create-reservation.dto.ts` — validation (categoryId + nom/prénom/téléphone).
- `src/reservations/reservations.service.spec.ts` — tests unitaires.

**Modifiés :**
- `prisma/schema.prisma` — enums `ReservationStatus`/`ReservationResolution`, modèles `Reservation` + `GateCashCollection`, champs réservation sur `TicketCategory`, relations inverses sur `Event`/`User`/`TicketCategory`.
- `prisma/migrations/<timestamp>_reservation_billets/migration.sql` — + index unique partiel (SQL manuel).
- `src/common/constants.ts` — `RESERVATION_DEFAULT_CAP`.
- `src/events/dto/ticket-category.dto.ts` — flag `reservationEnabled?`.
- `src/events/events.service.ts` — persistance du flag (catégorie base) + bloc `reservation` dans `findOne`.
- `src/events/events.service.spec.ts`.
- `src/orders/MyTickets.service.ts` — fusionner les réservations dans `getMyTickets` ; résolution `Reservation` dans `getQrToken`/`getTicketForRender`.
- `src/orders/MyTickets.controller.ts` — adapter `download` au shape normalisé de rendu.
- `src/orders/dto/MyTickets.dto.ts` — champ `isReservation`.
- `src/agent/agent.service.ts` — scan résout aussi `Reservation` ; `collectReservation`/`deleteReservation` ; bloc dashboard `reservations`.
- `src/agent/agent.controller.ts` — routes `collect`/`delete`.
- `src/agent/dto/ScanDashboard.dto.ts` — bloc `reservations`.
- `src/agent/agent.service.spec.ts`.
- `src/app.module.ts` — importe `ReservationsModule`.

---

## Task 1 : Schéma Prisma + migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `src/common/constants.ts`
- Create: `prisma/migrations/<timestamp>_reservation_billets/migration.sql`

**Interfaces:**
- Produces (consommé par toutes les tâches suivantes) :
  - `enum ReservationStatus { RESERVED, USED, CANCELLED }`
  - `enum ReservationResolution { PENDING, COLLECTED, DELETED }`
  - `model Reservation { id, eventId, categoryId, userId, qrToken(unique), status, resolution, holderFirstName, holderLastName, holderPhone, paidAtGate, resolvedByAgentId, reservedAt, resolvedAt, expiresAt, createdAt }` → client `prisma.reservation`
  - `model GateCashCollection { id, eventId, reservationId(unique), amount, currency, agentId, createdAt }` → client `prisma.gateCashCollection`
  - `TicketCategory.reservationEnabled: boolean`, `reservationCap: int`, `reservedCount: int`
  - `const RESERVATION_DEFAULT_CAP = 50`

- [ ] **Step 1 : Constante**

Dans `src/common/constants.ts` :

```ts
// Plafond par défaut de réservations actives (cash à la porte) par catégorie d'entrée.
export const RESERVATION_DEFAULT_CAP = 50;
```

- [ ] **Step 2 : Enums + modèles dans `prisma/schema.prisma`**

Ajouter les enums :

```prisma
enum ReservationStatus {
  RESERVED   // réservé, non payé (QR → pop-up jaune au scan)
  USED       // encaissé cash + admis à la porte (usage unique)
  CANCELLED  // supprimé par l'agent
}

enum ReservationResolution {
  PENDING    // en attente de passage à la porte
  COLLECTED  // encaissé cash à la porte
  DELETED    // supprimé par l'agent
}
```

Ajouter les modèles :

```prisma
// Réservation (cash à la porte). Entité de 1re classe : NI Order NI Ticket. Porte son propre
// qrToken scanné à la porte, et vit tout son cycle de vie dans cette seule ligne (seul le statut change).
model Reservation {
  id                String                @id @default(uuid())
  eventId           String
  event             Event                 @relation(fields: [eventId], references: [id])
  categoryId        String
  category          TicketCategory        @relation(fields: [categoryId], references: [id])
  userId            String                // compte qui réserve
  user              User                  @relation(fields: [userId], references: [id])

  qrToken           String                @unique // token opaque, scanné à la porte
  status            ReservationStatus     @default(RESERVED)
  resolution        ReservationResolution @default(PENDING)

  // Contact saisi dans le pop-up — stocké ICI, JAMAIS sur User (le porteur peut différer
  // du titulaire du compte → permet de faire la différence).
  holderFirstName   String
  holderLastName    String
  holderPhone       String

  paidAtGate        Boolean               @default(false)
  resolvedByAgentId String?               // agent ayant encaissé/supprimé (réconciliation)
  reservedAt        DateTime              @default(now())
  resolvedAt        DateTime?
  expiresAt         DateTime              // = event.endDate
  createdAt         DateTime              @default(now())

  gateCashCollection GateCashCollection?

  @@index([eventId])
  @@index([qrToken])
  @@index([userId])
}

// Cash encaissé à la porte. SÉPARÉ du LedgerEntry (dette de Vybe envers l'organisateur) :
// ce cash ne transite jamais par Vybe → n'affecte ni soldes ni retraits. Source du compteur
// dashboard "Total encaissement billets réservés".
model GateCashCollection {
  id            String      @id @default(uuid())
  eventId       String
  reservationId String      @unique // 1 encaissement par réservation (idempotence)
  reservation   Reservation @relation(fields: [reservationId], references: [id])
  amount        Float               // = prix de la catégorie à l'instant de l'encaissement
  currency      Currency
  agentId       String              // agent encaisseur (attribution)
  createdAt     DateTime    @default(now())

  @@index([eventId])
}
```

- [ ] **Step 3 : Champs réservation sur `TicketCategory` + relation inverse**

Dans `model TicketCategory`, après `giftedCount` :

```prisma
  // --- réservation (cash à la porte) ---
  reservationEnabled Boolean @default(false) // true = catégorie d'entrée ouverte à la réservation (une seule par événement)
  reservationCap     Int     @default(50)    // plafond de réservations actives
  reservedCount      Int     @default(0)      // réservations qui "tiennent" : +1 réserve, -1 supprime, INCHANGÉ à l'encaissement
```

Et, dans les relations du même modèle (à côté de `tickets Ticket[]`) :

```prisma
  reservations Reservation[]
```

- [ ] **Step 4 : Relations inverses sur `Event` et `User`**

Dans `model Event`, à côté de `agents Agent[]` :

```prisma
  reservations Reservation[]
```

Dans `model User`, à côté de `agentAccess Agent[]` :

```prisma
  reservations Reservation[]
```

- [ ] **Step 5 : Régénérer le client Prisma**

Run: `npx prisma generate`
Expected: `✔ Generated Prisma Client` sans erreur.

- [ ] **Step 6 : Créer la migration (sans appliquer) + index partiel manuel**

> ⚠️ Base Neon partagée. Générer le SQL sans l'exécuter sur la base commune :

Run: `npx prisma migrate dev --name reservation_billets --create-only`
Expected: dossier `prisma/migrations/<timestamp>_reservation_billets/migration.sql` créé.

Éditer ce `migration.sql` pour ajouter à la fin l'index unique partiel :

```sql
-- "1 réservation active par compte et par événement" : garantie atomique anti-course.
-- Une 2e réservation RESERVED du même user sur le même event viole cet index (P2002).
-- Dès que la réservation quitte RESERVED (encaissée=USED ou supprimée=CANCELLED), la ligne
-- sort de l'index → le user peut réserver à nouveau.
CREATE UNIQUE INDEX "one_active_reservation_per_user"
  ON "Reservation" ("eventId", "userId")
  WHERE "status" = 'RESERVED';
```

- [ ] **Step 7 : Build**

Run: `npm run build`
Expected: build OK (types Prisma à jour).

- [ ] **Step 8 : Commit (proposer)**

```bash
git add prisma/schema.prisma prisma/migrations src/common/constants.ts
git commit -m "feat(reservation): schéma Prisma (table Reservation dédiée, GateCashCollection, index partiel)"
```

---

## Task 2 : Flag réservation à la création d'événement

Active la réservation sur la **catégorie de base (index 0)**, pilotée par un flag DTO.

**Files:**
- Modify: `src/events/dto/ticket-category.dto.ts`
- Modify: `src/events/events.service.ts` (bloc `ticketCategories.create` + garde)
- Test: `src/events/events.service.spec.ts`

**Interfaces:**
- Consumes : champs `TicketCategory` de la Tâche 1.
- Produces : catégorie index 0 avec `reservationEnabled=true`, `reservationCap=RESERVATION_DEFAULT_CAP`, `reservedCount=0` quand demandé.

- [ ] **Step 1 : Test (échec)**

Dans `src/events/events.service.spec.ts` :

```ts
it('active reservationEnabled sur la catégorie de base quand demandé', async () => {
  const dto = validCreateEventDto({
    ticketCategories: [
      { name: 'Entrée', price: 10, ticketDesignUrl: 'u', reservationEnabled: true },
      { name: 'VIP', price: 50, ticketDesignUrl: 'u', totalStock: 100 },
    ],
  });
  prisma.event.create.mockResolvedValue({ id: 'ev1', reference: 'VYBE-XXX', createdBy: {} });
  await service.createEvent('user1', dto);
  const created = prisma.event.create.mock.calls[0][0].data.ticketCategories.create;
  expect(created[0]).toMatchObject({ reservationEnabled: true, reservationCap: 50, reservedCount: 0 });
  expect(created[1].reservationEnabled).toBe(false);
});

it('rejette reservationEnabled sur une catégorie non-base (index >= 1)', async () => {
  const dto = validCreateEventDto({
    ticketCategories: [
      { name: 'Entrée', price: 10, ticketDesignUrl: 'u' },
      { name: 'VIP', price: 50, ticketDesignUrl: 'u', totalStock: 100, reservationEnabled: true },
    ],
  });
  await expect(service.createEvent('user1', dto)).rejects.toThrow(/réservation/i);
});
```

> `validCreateEventDto(...)` : réutiliser le helper du fichier s'il existe, sinon construire un DTO minimal valide inline (dates futures, `termsAccepted: true`, 1 poster) en s'inspirant des tests existants.

- [ ] **Step 2 : Lancer (échec attendu)**

Run: `npx jest src/events/events.service.spec.ts -t "reservationEnabled"`
Expected: FAIL.

- [ ] **Step 3 : Flag DTO**

Dans `src/events/dto/ticket-category.dto.ts`, après `benefits`, et ajouter `IsBoolean` à l'import :

```ts
  // Ouvre la réservation (cash à la porte) sur CETTE catégorie. Honoré uniquement sur la
  // catégorie de base (index 0) ; rejeté sur les catégories spéciales par EventsService.
  @IsOptional()
  @IsBoolean()
  reservationEnabled?: boolean;
```

- [ ] **Step 4 : Garde + persistance**

Dans `src/events/events.service.ts`, après le calcul de `cats` (zone des validations métier), ajouter :

```ts
// Réservation autorisée UNIQUEMENT sur la catégorie de base (index 0).
if (cats.some((t, i) => i > 0 && t.reservationEnabled)) {
  throw new BadRequestException(
    'La réservation ne peut être activée que sur la catégorie d’entrée (1ʳᵉ catégorie).',
  );
}
```

Dans `ticketCategories.create: dto.ticketCategories.map((t, i) => ({ ... }))`, ajouter :

```ts
            reservationEnabled: i === 0 ? t.reservationEnabled === true : false,
            reservationCap: RESERVATION_DEFAULT_CAP,
            reservedCount: 0,
```

Importer `RESERVATION_DEFAULT_CAP` depuis `src/common/constants` ; vérifier que `BadRequestException` est importé.

- [ ] **Step 5 : Lancer (succès)**

Run: `npx jest src/events/events.service.spec.ts`
Expected: PASS.

- [ ] **Step 6 : Commit (proposer)**

```bash
git add src/events/dto/ticket-category.dto.ts src/events/events.service.ts src/events/events.service.spec.ts
git commit -m "feat(reservation): activer la réservation sur la catégorie d'entrée à la création"
```

---

## Task 3 : Création de réservation (service + controller + DTO)

`POST /reservations` (auth USER) : crée atomiquement la réservation (plafond + 1/compte).

**Files:**
- Create: `src/reservations/dto/create-reservation.dto.ts`
- Create: `src/reservations/reservations.service.ts`
- Create: `src/reservations/reservations.controller.ts`
- Create: `src/reservations/reservations.module.ts`
- Create: `src/reservations/reservations.service.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes : enums/modèles Tâche 1 ; `JwtAuthGuard`, `RolesGuard`, `@Roles('USER')`.
- Produces :
  - `ReservationsService.create(userId: string, dto: CreateReservationDto): Promise<{ reservationId: string; reference: string; qrToken: string }>`
  - `ReservationsService.hasActiveReservation(userId: string, eventId: string): Promise<boolean>`

- [ ] **Step 1 : DTO**

`src/reservations/dto/create-reservation.dto.ts` :

```ts
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateReservationDto {
  @IsUUID('4', { message: 'Catégorie invalide.' })
  categoryId: string;

  @IsString()
  @IsNotEmpty({ message: 'Le prénom est requis.' })
  @MaxLength(80)
  holderFirstName: string;

  @IsString()
  @IsNotEmpty({ message: 'Le nom est requis.' })
  @MaxLength(80)
  holderLastName: string;

  @IsString()
  @IsNotEmpty({ message: 'Le téléphone est requis.' })
  @MaxLength(30)
  holderPhone: string;
}
```

- [ ] **Step 2 : Tests (échec)**

`src/reservations/reservations.service.spec.ts` (pattern `$transaction` de `payments.service.spec.ts`) :

```ts
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('ReservationsService', () => {
  let service: ReservationsService;
  let tx: { $executeRaw: jest.Mock; reservation: { create: jest.Mock } };
  let prisma: {
    ticketCategory: { findUnique: jest.Mock };
    reservation: { count: jest.Mock };
    $transaction: jest.Mock;
  };

  const baseCategory = {
    id: 'cat1', name: 'Entrée', price: 10, reservationEnabled: true,
    event: { id: 'ev1', reference: 'VYBE-X', status: 'PUBLISHED', priceCurrency: 'USD',
             endDate: new Date(Date.now() + 86400000), purchaseDeadline: new Date(Date.now() + 3600000) },
  };
  const dto = (o: any = {}) => ({ categoryId: 'cat1', holderFirstName: 'A', holderLastName: 'B', holderPhone: '+243900000000', ...o });

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      reservation: { create: jest.fn().mockResolvedValue({ id: 'r1', qrToken: 'qr-uuid' }) },
    };
    prisma = {
      ticketCategory: { findUnique: jest.fn().mockResolvedValue(baseCategory) },
      reservation: { count: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    service = new ReservationsService(prisma as unknown as PrismaService);
  });

  it('crée une réservation : incrément atomique + ligne Reservation RESERVED', async () => {
    const res = await service.create('user1', dto());
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.reservation.create.mock.calls[0][0].data).toMatchObject({
      eventId: 'ev1', categoryId: 'cat1', userId: 'user1',
      status: 'RESERVED', resolution: 'PENDING',
      holderFirstName: 'A', holderLastName: 'B', holderPhone: '+243900000000',
    });
    expect(res).toMatchObject({ reservationId: 'r1', reference: 'VYBE-X', qrToken: 'qr-uuid' });
  });

  it('rejette si la catégorie n’est pas réservable', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue({ ...baseCategory, reservationEnabled: false });
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejette (plafond atteint) si l’incrément conditionnel n’affecte aucune ligne', async () => {
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(ConflictException);
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('rejette (déjà réservé) si la création viole l’index unique (P2002)', async () => {
    tx.reservation.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejette si l’événement n’est pas PUBLISHED', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue({ ...baseCategory, event: { ...baseCategory.event, status: 'PENDING_REVIEW' } });
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(ForbiddenException);
  });
});
```

- [ ] **Step 3 : Lancer (échec attendu)**

Run: `npx jest src/reservations/reservations.service.spec.ts`
Expected: FAIL (`Cannot find module './reservations.service'`).

- [ ] **Step 4 : Service**

`src/reservations/reservations.service.ts` :

```ts
import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateReservationDto } from './dto/create-reservation.dto';

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateReservationDto) {
    const category = await this.prisma.ticketCategory.findUnique({
      where: { id: dto.categoryId },
      include: { event: true },
    });
    if (!category) throw new NotFoundException('Catégorie de billet introuvable.');
    if (!category.reservationEnabled) {
      throw new ForbiddenException("Cette catégorie n'est pas ouverte à la réservation.");
    }
    const event = category.event;
    if (event.status !== 'PUBLISHED') throw new ForbiddenException("Cet événement n'est pas ouvert.");
    if (event.purchaseDeadline < new Date()) throw new ForbiddenException('Les réservations sont clôturées.');

    const qrToken = randomUUID();

    try {
      const reservation = await this.prisma.$transaction(async (tx) => {
        // 1. Plafond atomique : +1 seulement si réservable ET sous le plafond. 0 ligne = saturé.
        const affected = await tx.$executeRaw`
          UPDATE "TicketCategory"
          SET "reservedCount" = "reservedCount" + 1
          WHERE "id" = ${dto.categoryId}
            AND "reservationEnabled" = true
            AND "reservedCount" < "reservationCap"`;
        if (affected === 0) {
          throw new ConflictException('Plus de réservations disponibles pour cet événement.');
        }

        // 2. Ligne Reservation. L'index unique partiel garantit "1 active / compte / event"
        //    → violation = déjà réservé (P2002, capturé plus bas → rollback du +1).
        return tx.reservation.create({
          data: {
            eventId: event.id,
            categoryId: dto.categoryId,
            userId,
            qrToken,
            status: 'RESERVED',
            resolution: 'PENDING',
            holderFirstName: dto.holderFirstName,
            holderLastName: dto.holderLastName,
            holderPhone: dto.holderPhone,
            reservedAt: new Date(),
            expiresAt: event.endDate,
          },
        });
      });

      return { reservationId: reservation.id, reference: event.reference, qrToken: reservation.qrToken };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new ConflictException('Vous avez déjà une réservation active pour cet événement.');
      }
      throw err;
    }
  }

  // Lecture d'UX : le front grise le bouton "Réserver" si true. Le POST reste la source de vérité.
  async hasActiveReservation(userId: string, eventId: string): Promise<boolean> {
    const count = await this.prisma.reservation.count({
      where: { userId, eventId, status: 'RESERVED' },
    });
    return count > 0;
  }
}
```

- [ ] **Step 5 : Controller**

`src/reservations/reservations.controller.ts` :

```ts
import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Post()
  async create(@Req() req, @Body() dto: CreateReservationDto) {
    return this.reservations.create(req.user.sub, dto);
  }

  // État "réservation active" du user pour un événement (grisage du bouton).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Get('active')
  async active(@Req() req, @Query('eventId') eventId: string) {
    return { hasActive: await this.reservations.hasActiveReservation(req.user.sub, eventId) };
  }
}
```

- [ ] **Step 6 : Module + enregistrement**

`src/reservations/reservations.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { ReservationsService } from './reservations.service';
import { ReservationsController } from './reservations.controller';

@Module({
  imports: [PrismaModule, AuthModule], // AuthModule exporte JwtModule + guards (cf. CLAUDE.md)
  controllers: [ReservationsController],
  providers: [ReservationsService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
```

Dans `src/app.module.ts`, ajouter `ReservationsModule` aux `imports` (+ import en tête).

- [ ] **Step 7 : Lancer (succès)**

Run: `npx jest src/reservations/reservations.service.spec.ts`
Expected: PASS (5 cas).

- [ ] **Step 8 : Build**

Run: `npm run build`
Expected: OK.

- [ ] **Step 9 : Commit (proposer)**

```bash
git add src/reservations src/app.module.ts
git commit -m "feat(reservation): endpoint POST /reservations atomique (plafond + 1/compte)"
```

---

## Task 4 : Exposer l'état réservation pour l'UX (findOne)

**Files:**
- Modify: `src/events/events.service.ts` (`findOne`)
- Test: `src/events/events.service.spec.ts`

**Interfaces:**
- Produces : `findOne(...)` renvoie `reservation: { enabled, categoryId, reservedCount, cap, saturated }`.

- [ ] **Step 1 : Test (échec)**

```ts
it('findOne expose l’état de réservation de la catégorie d’entrée', async () => {
  prisma.event.findUnique.mockResolvedValue({
    id: 'ev1', reference: 'VYBE-X', title: 'T',
    ticketCategories: [
      { id: 'cat0', name: 'Entrée', price: 10, reservationEnabled: true, reservationCap: 50, reservedCount: 50 },
      { id: 'cat1', name: 'VIP', price: 50, reservationEnabled: false, reservationCap: 50, reservedCount: 0 },
    ],
    mediaFiles: [], createdBy: {},
  });
  const res: any = await service.findOne('ev1');
  expect(res.reservation).toMatchObject({ enabled: true, categoryId: 'cat0', reservedCount: 50, cap: 50, saturated: true });
});
```

> Adapter le mock à l'`include` réel de `findOne` (ajouter les champs réservation aux catégories).

- [ ] **Step 2 : Lancer (échec)**

Run: `npx jest src/events/events.service.spec.ts -t "état de réservation"`
Expected: FAIL.

- [ ] **Step 3 : Implémenter**

Dans `findOne`, avant le `return`, l'`include: { ticketCategories: true }` renvoie déjà les champs. Calculer :

```ts
const entry = event.ticketCategories.find((c) => c.reservationEnabled) ?? null;
const reservation = entry
  ? { enabled: true, categoryId: entry.id, reservedCount: entry.reservedCount, cap: entry.reservationCap, saturated: entry.reservedCount >= entry.reservationCap }
  : { enabled: false, categoryId: null, reservedCount: 0, cap: 0, saturated: false };
```

Ajouter `reservation` à l'objet retourné.

- [ ] **Step 4 : Lancer (succès)**

Run: `npx jest src/events/events.service.spec.ts`
Expected: PASS.

- [ ] **Step 5 : Commit (proposer)**

```bash
git add src/events/events.service.ts src/events/events.service.spec.ts
git commit -m "feat(reservation): exposer l'état de réservation dans GET /events/:id"
```

---

## Task 5 : Billet réservé visible dans « Mes billets »

Les réservations (table dédiée) sont fusionnées dans `GET /me/tickets` avec `isReservation=true` ; le QR et le téléchargement résolvent aussi les réservations.

**Files:**
- Modify: `src/orders/MyTickets.service.ts`
- Modify: `src/orders/MyTickets.controller.ts` (`download` → shape normalisé)
- Modify: `src/orders/dto/MyTickets.dto.ts` (champ `isReservation`)
- Test: `src/orders/MyTickets.service.spec.ts` (créer si absent)

**Interfaces:**
- Consumes : `prisma.reservation`, renderer `TicketAssetService.renderTicketPng/Pdf(input)`.
- Produces :
  - chaque item billet porte `isReservation: boolean` (et pour une réservation, `qrStatus` vaut `'RESERVED' | 'USED' | 'CANCELLED'`).
  - `getQrToken(userId, id)` et `getTicketForRender(userId, id)` résolvent un `Ticket` **ou** une `Reservation` (propriété `userId`).
  - `getTicketForRender` renvoie un shape **plat normalisé** : `{ qrToken, eventTitle, eventCategory, startDate, categoryName, designUrl, isGift }`.

- [ ] **Step 1 : Tests (échec)**

Dans `src/orders/MyTickets.service.spec.ts` :

```ts
it('inclut les réservations du user avec isReservation=true', async () => {
  prisma.ticket.findMany.mockResolvedValue([]); // aucun billet payé
  prisma.reservation.findMany.mockResolvedValue([
    {
      id: 'r1', status: 'RESERVED', resolvedAt: null, expiresAt: new Date(Date.now() + 90000000),
      category: {
        name: 'Entrée', ticketDesignUrl: 'u',
        event: { id: 'ev1', reference: 'VYBE-X', title: 'T', category: 'CONCERT',
                 startDate: new Date(Date.now() + 86400000), endDate: new Date(Date.now() + 90000000),
                 location: 'L', mediaFiles: [] },
      },
    },
  ]);
  const res = await service.getMyTickets('user1');
  const item = res.upcoming[0].tickets[0];
  expect(item).toMatchObject({ id: 'r1', isReservation: true, qrStatus: 'RESERVED' });
});

it('getQrToken résout une réservation si l’id n’est pas un billet', async () => {
  prisma.ticket.findFirst.mockResolvedValue(null);
  prisma.reservation.findFirst.mockResolvedValue({ qrToken: 'qr-res' });
  expect(await service.getQrToken('user1', 'r1')).toEqual({ qrToken: 'qr-res' });
});
```

> Le harnais Prisma mocké du fichier doit déclarer `reservation: { findMany, findFirst }`. Pour le billet payé (branche existante), `prisma.ticket.findMany` reste la source.

- [ ] **Step 2 : Lancer (échec)**

Run: `npx jest src/orders/MyTickets.service.spec.ts -t "réservations|réservation"`
Expected: FAIL.

- [ ] **Step 3 : DTO**

Dans `src/orders/dto/MyTickets.dto.ts`, sur l'item billet, ajouter `isReservation: boolean;` et élargir `qrStatus` pour accepter la réservation :

```ts
  qrStatus: 'UNUSED' | 'USED' | 'CANCELLED' | 'RESERVED';
  isReservation: boolean;
```

- [ ] **Step 4 : Fusionner les réservations dans `getScope`**

Dans `src/orders/MyTickets.service.ts` : marquer les items billets existants `isReservation: false` dans `groupByEvent` (au `entry.tickets.push`). Puis ajouter la récupération des réservations et leur fusion. Modifier `getScope` :

```ts
private async getScope(userId: string, now: Date, scope: 'upcoming' | 'past') {
  const rows = await this.fetchRows(userId, now, scope);
  const truncated = rows.length > MY_TICKETS_MAX_PER_SCOPE;
  const bounded = truncated ? rows.slice(0, MY_TICKETS_MAX_PER_SCOPE) : rows;
  const events = this.groupByEvent(bounded);
  await this.mergeReservations(events, userId, now, scope); // injecte les réservations
  return { events, truncated };
}
```

Ajouter la méthode (requête `Reservation` + mapping vers le même shape d'item, groupé par event) :

```ts
private async mergeReservations(
  events: MyEventTicketsDto[],
  userId: string,
  now: Date,
  scope: 'upcoming' | 'past',
): Promise<void> {
  const cutoff = new Date(now.getTime() - DAY_MS);
  const isUpcoming = scope === 'upcoming';
  const rows = await this.prisma.reservation.findMany({
    where: {
      userId,
      // supprimée visible 24h (comme un billet annulé), sinon disparaît
      OR: [{ status: { not: 'CANCELLED' } }, { resolvedAt: { gte: cutoff } }],
      event: { endDate: isUpcoming ? { gte: now } : { lt: now } },
    },
    orderBy: [{ event: { startDate: isUpcoming ? 'asc' : 'desc' } }, { createdAt: 'asc' }],
    select: {
      id: true, status: true, expiresAt: true, resolvedAt: true,
      category: {
        select: {
          name: true, ticketDesignUrl: true,
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

  const byId = new Map(events.map((e) => [e.event.id, e]));
  for (const r of rows) {
    const ev = r.category.event;
    let entry = byId.get(ev.id);
    if (!entry) {
      entry = {
        event: {
          id: ev.id, reference: ev.reference, title: ev.title, category: ev.category,
          startDate: ev.startDate, endDate: ev.endDate, location: ev.location,
          posterUrl: ev.mediaFiles[0]?.url ?? null,
        },
        tickets: [],
      };
      byId.set(ev.id, entry);
      events.push(entry);
    }
    entry.tickets.push({
      id: r.id,
      categoryName: r.category.name,
      qrStatus: r.status, // 'RESERVED' | 'USED' | 'CANCELLED'
      ticketDesignUrl: r.category.ticketDesignUrl,
      expiresAt: r.expiresAt,
      cancelledAt: r.status === 'CANCELLED' ? r.resolvedAt : null,
      isReservation: true,
    });
  }
}
```

- [ ] **Step 5 : Résoudre `Reservation` dans `getQrToken`**

Remplacer `getQrToken` : essayer le billet, sinon la réservation (propriété `userId`) :

```ts
async getQrToken(userId: string, id: string): Promise<{ qrToken: string }> {
  const ticket = await this.prisma.ticket.findFirst({ where: { id, order: { userId } }, select: { qrToken: true } });
  if (ticket) return { qrToken: ticket.qrToken };
  const reservation = await this.prisma.reservation.findFirst({ where: { id, userId }, select: { qrToken: true } });
  if (reservation) return { qrToken: reservation.qrToken };
  throw new NotFoundException('Billet introuvable.');
}
```

- [ ] **Step 6 : Shape normalisé dans `getTicketForRender`**

Remplacer `getTicketForRender` pour renvoyer un shape plat, billet **ou** réservation :

```ts
async getTicketForRender(userId: string, id: string) {
  const t = await this.prisma.ticket.findFirst({
    where: { id, order: { userId } },
    select: {
      qrToken: true,
      order: { select: { paymentStatus: true } },
      ticketCategory: { select: { name: true, ticketDesignUrl: true, event: { select: { title: true, category: true, startDate: true } } } },
    },
  });
  if (t) {
    return {
      qrToken: t.qrToken,
      eventTitle: t.ticketCategory.event.title,
      eventCategory: t.ticketCategory.event.category,
      startDate: t.ticketCategory.event.startDate,
      categoryName: t.ticketCategory.name,
      designUrl: t.ticketCategory.ticketDesignUrl,
      isGift: t.order.paymentStatus === 'GIFT',
    };
  }
  const r = await this.prisma.reservation.findFirst({
    where: { id, userId },
    select: { qrToken: true, category: { select: { name: true, ticketDesignUrl: true, event: { select: { title: true, category: true, startDate: true } } } } },
  });
  if (r) {
    return {
      qrToken: r.qrToken,
      eventTitle: r.category.event.title,
      eventCategory: r.category.event.category,
      startDate: r.category.event.startDate,
      categoryName: r.category.name,
      designUrl: r.category.ticketDesignUrl,
      isGift: false,
    };
  }
  throw new NotFoundException('Billet introuvable.');
}
```

- [ ] **Step 7 : Adapter le controller `download`**

Dans `src/orders/MyTickets.controller.ts`, `download` utilise désormais le shape plat :

```ts
const t = await this.myTicketsService.getTicketForRender(req.user.sub, id);
const input = {
  qrToken: t.qrToken,
  eventTitle: t.eventTitle,
  eventCategory: t.eventCategory,
  startDate: t.startDate,
  categoryName: t.categoryName,
  designUrl: t.designUrl,
};
// ... rendu identique ...
const safe = `${t.eventTitle}-${t.categoryName}`.replace(/[^\w.-]+/g, '_');
// ... et le marquage GIFT :
if (t.isGift) {
  await this.myTicketsService.markGiftDownloaded(req.user.sub, id);
}
```

(Remplacer les anciens accès `t.ticketCategory.event.*` / `t.order.paymentStatus`.)

- [ ] **Step 8 : Lancer (succès)**

Run: `npx jest src/orders/MyTickets.service.spec.ts`
Expected: PASS.

- [ ] **Step 9 : Build**

Run: `npm run build`
Expected: OK.

- [ ] **Step 10 : Commit (proposer)**

```bash
git add src/orders/MyTickets.service.ts src/orders/MyTickets.controller.ts src/orders/dto/MyTickets.dto.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(reservation): billet réservé visible + téléchargeable dans Mes billets"
```

---

## Task 6 : Scan — résolution d'une réservation (pop-up jaune)

Le scan résout le `qrToken` sur `Ticket` (payé, inchangé) **ou** sur `Reservation` (pop-up jaune).

**Files:**
- Modify: `src/agent/agent.service.ts` (`scan`)
- Test: `src/agent/agent.service.spec.ts`

**Interfaces:**
- Consumes : `prisma.reservation`, `req.user.eventId`/`agentId`.
- Produces : `scan(...)` renvoie, pour une réservation `RESERVED`, `{ reserved: true, reservationId, amount, currency, categoryName, holderName, holderPhone }` (aucune transition). Billet payé : comportement vert inchangé.

- [ ] **Step 1 : Test (échec)**

```ts
it('scan d’un qrToken de réservation RESERVED renvoie le payload de recouvrement', async () => {
  prisma.agent.findUnique.mockResolvedValue({ id: 'ag1', active: true });
  prisma.ticket.findUnique.mockResolvedValue(null); // pas un billet
  prisma.reservation.findUnique.mockResolvedValue({
    id: 'r1', status: 'RESERVED', eventId: 'ev1',
    expiresAt: new Date(Date.now() + 86400000),
    holderFirstName: 'Ada', holderLastName: 'L', holderPhone: '+243900000000',
    category: { name: 'Entrée', price: 10, event: { priceCurrency: 'USD' } },
  });
  const res: any = await service.scan('ev1', 'ag1', 'qr-res');
  expect(res).toMatchObject({ reserved: true, reservationId: 'r1', amount: 10, currency: 'USD', categoryName: 'Entrée' });
  expect(res.holderName).toContain('Ada');
});

it('scan rejette une réservation d’un autre événement', async () => {
  prisma.agent.findUnique.mockResolvedValue({ id: 'ag1', active: true });
  prisma.ticket.findUnique.mockResolvedValue(null);
  prisma.reservation.findUnique.mockResolvedValue({ id: 'r1', status: 'RESERVED', eventId: 'AUTRE', expiresAt: new Date(Date.now() + 86400000), category: { name: 'E', price: 10, event: { priceCurrency: 'USD' } } });
  await expect(service.scan('ev1', 'ag1', 'qr-res')).rejects.toBeInstanceOf(ForbiddenException);
});
```

> Ajouter `reservation: { findUnique: jest.fn() }` au type/mock `prisma` du fichier, avec défaut `null`.

- [ ] **Step 2 : Lancer (échec)**

Run: `npx jest src/agent/agent.service.spec.ts -t "réservation RESERVED"`
Expected: FAIL.

- [ ] **Step 3 : Implémenter la branche réservation dans `scan`**

Dans `src/agent/agent.service.ts`, après la garde agent (`if (!agent || !agent.active) ...`), **avant** le lookup billet existant, ne rien changer ; après la résolution billet, si `!ticket`, tenter la réservation. Structure recommandée : garder le lookup `ticket` ; si `ticket` null, faire :

```ts
if (!ticket) {
  const reservation = await this.prisma.reservation.findUnique({
    where: { qrToken },
    include: { category: { include: { event: true } } },
  });
  if (!reservation) throw new NotFoundException("Ce billet n'appartient pas à votre événement.");
  if (reservation.eventId !== eventId) throw new ForbiddenException("Ce billet n'appartient pas à votre événement.");
  if (reservation.expiresAt < new Date()) throw new ForbiddenException('Billet expiré');
  if (reservation.status === 'CANCELLED') throw new ForbiddenException('Réservation annulée.');
  if (reservation.status === 'USED') throw new ConflictException({ message: 'Réservation déjà encaissée.', resolvedAt: reservation.resolvedAt?.toISOString() });

  const holderName = [reservation.holderFirstName, reservation.holderLastName].filter(Boolean).join(' ').trim() || 'Porteur inconnu';
  return {
    reserved: true as const,
    reservationId: reservation.id,
    amount: reservation.category.price,
    currency: reservation.category.event.priceCurrency,
    categoryName: reservation.category.name,
    holderName,
    holderPhone: reservation.holderPhone,
  };
}
```

> Le reste de `scan` (branche billet payé `UNUSED → USED`) est inchangé. Le `throw new NotFoundException` actuellement levé quand `!ticket` est **remplacé** par ce bloc.

- [ ] **Step 4 : Lancer (succès)**

Run: `npx jest src/agent/agent.service.spec.ts`
Expected: PASS (scan réservé + scan payé toujours vert).

- [ ] **Step 5 : Commit (proposer)**

```bash
git add src/agent/agent.service.ts src/agent/agent.service.spec.ts
git commit -m "feat(reservation): scan résout une réservation → pop-up de recouvrement"
```

---

## Task 7 : Actions agent — Encaisser / Supprimer

Deux actions atomiques sur la ligne `Reservation`, horodatées et attribuées à l'agent. QR mort après.

**Files:**
- Modify: `src/agent/agent.service.ts` (`collectReservation`, `deleteReservation`)
- Modify: `src/agent/agent.controller.ts`
- Test: `src/agent/agent.service.spec.ts`

**Interfaces:**
- Consumes : `req.user.eventId`/`agentId` ; `ScanDto` (`{ qrToken }`) ; `prisma.reservation`, `prisma.gateCashCollection`.
- Produces :
  - `collectReservation(eventId, agentId, qrToken): Promise<{ status: string; amount: number; currency: string; holderName: string }>`
  - `deleteReservation(eventId, agentId, qrToken): Promise<{ status: string }>`

- [ ] **Step 1 : Tests (échec)**

Ajouter au harnais `tx` du fichier : `reservation: { findUnique, updateMany }`, `gateCashCollection: { create }`, `$executeRaw`, et `prisma.$transaction = jest.fn().mockImplementation(async (cb) => cb(tx))`.

```ts
it('Encaisser : RESERVED → USED + GateCashCollection, reservedCount inchangé', async () => {
  prisma.agent.findUnique.mockResolvedValue({ id: 'ag1', active: true });
  tx.reservation.findUnique.mockResolvedValue({ id: 'r1', status: 'RESERVED', eventId: 'ev1', holderFirstName: 'A', holderLastName: 'B', category: { price: 10, event: { priceCurrency: 'USD' } } });
  tx.reservation.updateMany.mockResolvedValue({ count: 1 });
  const res = await service.collectReservation('ev1', 'ag1', 'qr-res');
  expect(tx.reservation.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'USED', resolution: 'COLLECTED', paidAtGate: true, resolvedByAgentId: 'ag1' });
  expect(tx.gateCashCollection.create.mock.calls[0][0].data).toMatchObject({ eventId: 'ev1', reservationId: 'r1', amount: 10, currency: 'USD', agentId: 'ag1' });
  expect(tx.$executeRaw).not.toHaveBeenCalled(); // reservedCount INCHANGÉ
  expect(res).toMatchObject({ amount: 10, currency: 'USD' });
});

it('Encaisser : rejet si déjà résolu (updateMany count 0)', async () => {
  prisma.agent.findUnique.mockResolvedValue({ id: 'ag1', active: true });
  tx.reservation.findUnique.mockResolvedValue({ id: 'r1', status: 'RESERVED', eventId: 'ev1', category: { price: 10, event: { priceCurrency: 'USD' } } });
  tx.reservation.updateMany.mockResolvedValue({ count: 0 });
  await expect(service.collectReservation('ev1', 'ag1', 'qr-res')).rejects.toBeInstanceOf(ConflictException);
  expect(tx.gateCashCollection.create).not.toHaveBeenCalled();
});

it('Supprimer : RESERVED → CANCELLED + reservedCount -= 1, pas de collection', async () => {
  prisma.agent.findUnique.mockResolvedValue({ id: 'ag1', active: true });
  tx.reservation.findUnique.mockResolvedValue({ id: 'r1', status: 'RESERVED', eventId: 'ev1', categoryId: 'cat0' });
  tx.reservation.updateMany.mockResolvedValue({ count: 1 });
  await service.deleteReservation('ev1', 'ag1', 'qr-res');
  expect(tx.reservation.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'CANCELLED', resolution: 'DELETED', resolvedByAgentId: 'ag1' });
  expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // décrément reservedCount
  expect(tx.gateCashCollection.create).not.toHaveBeenCalled();
});

it('Encaisser : rejet si la réservation n’appartient pas à l’événement de l’agent', async () => {
  prisma.agent.findUnique.mockResolvedValue({ id: 'ag1', active: true });
  tx.reservation.findUnique.mockResolvedValue({ id: 'r1', status: 'RESERVED', eventId: 'AUTRE', category: { price: 10, event: { priceCurrency: 'USD' } } });
  await expect(service.collectReservation('ev1', 'ag1', 'qr-res')).rejects.toBeInstanceOf(ForbiddenException);
});
```

- [ ] **Step 2 : Lancer (échec)**

Run: `npx jest src/agent/agent.service.spec.ts -t "Encaisser|Supprimer"`
Expected: FAIL.

- [ ] **Step 3 : `collectReservation`**

```ts
async collectReservation(eventId: string, agentId: string, qrToken: string) {
  const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || !agent.active) throw new ForbiddenException('Agent révoqué ou inexistant.');

  return this.prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({
      where: { qrToken },
      include: { category: { include: { event: true } } },
    });
    if (!reservation) throw new NotFoundException('Réservation introuvable.');
    if (reservation.eventId !== eventId) throw new ForbiddenException("Cette réservation n'appartient pas à votre événement.");

    // Transition conditionnelle (anti-double-action, anti-course) : seul RESERVED passe.
    const { count } = await tx.reservation.updateMany({
      where: { qrToken, status: 'RESERVED' },
      data: { status: 'USED', resolution: 'COLLECTED', paidAtGate: true, resolvedAt: new Date(), resolvedByAgentId: agentId },
    });
    if (count !== 1) throw new ConflictException('Réservation déjà résolue.');

    // Cash tracé hors ledger IOU (reservedCount INCHANGÉ : la place reste comptée parmi les 50).
    await tx.gateCashCollection.create({
      data: {
        eventId,
        reservationId: reservation.id,
        amount: reservation.category.price,
        currency: reservation.category.event.priceCurrency,
        agentId,
      },
    });

    const holderName = [reservation.holderFirstName, reservation.holderLastName].filter(Boolean).join(' ').trim() || 'Porteur inconnu';
    return { status: 'Encaissé — accès accordé.', amount: reservation.category.price, currency: reservation.category.event.priceCurrency, holderName };
  });
}
```

- [ ] **Step 4 : `deleteReservation`**

```ts
async deleteReservation(eventId: string, agentId: string, qrToken: string) {
  const agent = await this.prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent || !agent.active) throw new ForbiddenException('Agent révoqué ou inexistant.');

  return this.prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({ where: { qrToken } });
    if (!reservation) throw new NotFoundException('Réservation introuvable.');
    if (reservation.eventId !== eventId) throw new ForbiddenException("Cette réservation n'appartient pas à votre événement.");

    const { count } = await tx.reservation.updateMany({
      where: { qrToken, status: 'RESERVED' },
      data: { status: 'CANCELLED', resolution: 'DELETED', resolvedAt: new Date(), resolvedByAgentId: agentId },
    });
    if (count !== 1) throw new ConflictException('Réservation déjà résolue.');

    // La place ne tient plus → le compteur recule (ex. 50 → 49).
    await tx.$executeRaw`
      UPDATE "TicketCategory"
      SET "reservedCount" = "reservedCount" - 1
      WHERE "id" = ${reservation.categoryId} AND "reservedCount" > 0`;

    return { status: 'Réservation supprimée.' };
  });
}
```

- [ ] **Step 5 : Routes du controller**

Dans `src/agent/agent.controller.ts` (réutilise `ScanDto`) :

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('AGENT')
@Post('agents/reservations/collect')
async collect(@Req() req, @Body() dto: ScanDto) {
  return this.agentService.collectReservation(req.user.eventId, req.user.agentId, dto.qrToken);
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('AGENT')
@Post('agents/reservations/delete')
async deleteReservation(@Req() req, @Body() dto: ScanDto) {
  return this.agentService.deleteReservation(req.user.eventId, req.user.agentId, dto.qrToken);
}
```

- [ ] **Step 6 : Lancer (succès)**

Run: `npx jest src/agent/agent.service.spec.ts`
Expected: PASS.

- [ ] **Step 7 : Build**

Run: `npm run build`
Expected: OK.

- [ ] **Step 8 : Commit (proposer)**

```bash
git add src/agent/agent.service.ts src/agent/agent.controller.ts src/agent/agent.service.spec.ts
git commit -m "feat(reservation): actions agent Encaisser/Supprimer (atomiques, attribuées, QR mort)"
```

---

## Task 8 : Dashboard — 3 compteurs réservation

Ajouter un bloc `reservations` au dashboard. Comme les réservations ne sont **pas** des `Ticket`, elles ne polluent **aucun** agrégat de scan existant → aucune exclusion nécessaire.

**Files:**
- Modify: `src/agent/agent.service.ts` (`getScanDashboard`)
- Modify: `src/agent/dto/ScanDashboard.dto.ts`
- Test: `src/agent/agent.service.spec.ts`

**Interfaces:**
- Consumes : `TicketCategory.reservedCount/reservationCap/reservationEnabled`, `prisma.reservation.count`, `prisma.gateCashCollection.aggregate`.
- Produces :
  ```ts
  reservations: { active: number; cap: number; collected: number; totalCollected: number; currency: 'USD' | 'CDF' | null; }
  ```

- [ ] **Step 1 : DTO**

Dans `src/agent/dto/ScanDashboard.dto.ts`, ajouter à `ScanDashboardResponseDto` :

```ts
  // Réservations cash à la porte (3 compteurs distincts).
  reservations: {
    active: number;         // réservations qui tiennent (X / cap)
    cap: number;            // plafond de la catégorie d'entrée
    collected: number;      // "Réservé-puis-payé" : réservations encaissées
    totalCollected: number; // "Total encaissement billets réservés" ($)
    currency: 'USD' | 'CDF' | null;
  };
```

- [ ] **Step 2 : Test (échec)**

```ts
it('expose le bloc reservations (actives, encaissées, total encaissé)', async () => {
  prisma.event.findUnique.mockResolvedValue({ id: 'ev1', reference: 'VYBE-X', title: 'T', createdById: 'user1', totalCapacity: null, priceCurrency: 'USD' });
  prisma.ticket.groupBy.mockResolvedValue([]);
  prisma.ticketCategory.findMany.mockResolvedValue([
    { id: 'cat0', name: 'Entrée', soldCount: 0, totalStock: null, giftedCount: 0, reservationEnabled: true, reservedCount: 50, reservationCap: 50 },
  ]);
  prisma.reservation = { count: jest.fn().mockResolvedValue(12) } as any;
  prisma.gateCashCollection = { aggregate: jest.fn().mockResolvedValue({ _sum: { amount: 120 } }) } as any;
  const res = await service.getScanDashboard('user1', 'VYBE-X');
  expect(res.reservations).toMatchObject({ active: 50, cap: 50, collected: 12, totalCollected: 120, currency: 'USD' });
});
```

> Ajouter `priceCurrency` au mock `event` et `reservationEnabled/reservedCount/reservationCap` au `select` mocké des catégories. Les défauts vides de `order.aggregate/groupBy` et `$queryRaw` sont déjà dans le `beforeEach`.

- [ ] **Step 3 : Lancer (échec)**

Run: `npx jest src/agent/agent.service.spec.ts -t "bloc reservations"`
Expected: FAIL.

- [ ] **Step 4 : Implémenter**

Dans `getScanDashboard`, ajouter `reservationEnabled: true, reservedCount: true, reservationCap: true` au `select` du `ticketCategory.findMany` existant. Avant le `return`, calculer :

```ts
const reservableCats = categories.filter((c: any) => c.reservationEnabled);
const reservationActive = reservableCats.reduce((acc: number, c: any) => acc + c.reservedCount, 0);
const reservationCap = reservableCats[0]?.reservationCap ?? 0;
const reservationCollected = await this.prisma.reservation.count({ where: { eventId, resolution: 'COLLECTED' } });
const collectionAgg = await this.prisma.gateCashCollection.aggregate({ where: { eventId }, _sum: { amount: true } });
const reservations = {
  active: reservationActive,
  cap: reservationCap,
  collected: reservationCollected,
  totalCollected: round2(collectionAgg._sum.amount ?? 0),
  currency: reservableCats.length > 0 ? event.priceCurrency : null,
};
```

Ajouter `reservations` à l'objet retourné.

> `event` provient de `findUnique({ where: { reference } })` sans `select` → `priceCurrency` est présent.

- [ ] **Step 5 : Lancer (succès)**

Run: `npx jest src/agent/agent.service.spec.ts`
Expected: PASS.

- [ ] **Step 6 : Commit (proposer)**

```bash
git add src/agent/agent.service.ts src/agent/dto/ScanDashboard.dto.ts src/agent/agent.service.spec.ts
git commit -m "feat(reservation): dashboard — 3 compteurs réservation (actives, réservé-puis-payé, total encaissé)"
```

---

## Task 9 : Tests transverses de cohérence + suite complète

**Files:**
- Modify: `src/reservations/reservations.service.spec.ts`, `src/agent/agent.service.spec.ts`

- [ ] **Step 1 : Invariant « pas de 51ᵉ »**

Confirmer le cas « plafond atteint » (Tâche 3) : `$executeRaw → 0` ⇒ `ConflictException` ⇒ `reservation.create` non appelé.

- [ ] **Step 2 : Invariant « QR mort après action »**

Confirmer (Tâche 7) : 2ᵉ action sur le même `qrToken` → `updateMany count 0` → `ConflictException`, ni `gateCashCollection` ni décrément.

- [ ] **Step 3 : Invariant « 1 réservation / compte » (P2002)**

Confirmer (Tâche 3) : `reservation.create` rejette `{ code: 'P2002' }` ⇒ `ConflictException` « déjà une réservation active ».

- [ ] **Step 4 : Invariant « Encaisser ne bouge pas le compteur, Supprimer le décrémente »**

Confirmer (Tâche 7) : `collectReservation` n'appelle jamais `tx.$executeRaw` ; `deleteReservation` l'appelle exactement une fois.

- [ ] **Step 5 : Suite complète**

Run: `npm test`
Expected: PASS — toutes les suites vertes.

- [ ] **Step 6 : Lint ciblé (sans réécriture de masse)**

Run: `npx eslint src/reservations src/agent/agent.service.ts src/events/events.service.ts src/orders/MyTickets.service.ts src/orders/MyTickets.controller.ts`
Expected: aucune erreur (warnings tolérés). **Ne pas** lancer `npm run lint` (`--fix`).

- [ ] **Step 7 : Commit (proposer)**

```bash
git add -A
git commit -m "test(reservation): invariants transverses (plafond atomique, QR mort, 1/compte, compteurs)"
```

---

## Contrats d'API (pour le plan frontend, repo séparé)

- **`GET /events/:id`** (public) — + `reservation: { enabled, categoryId, reservedCount, cap, saturated }`. Bouton **Réserver** visible si `enabled`, grisé si `saturated` ou réservation active du user.
- **`GET /reservations/active?eventId=`** (auth USER) — `{ hasActive: boolean }` → grise le bouton.
- **`POST /reservations`** (auth USER) — body `{ categoryId, holderFirstName, holderLastName, holderPhone }` → `{ reservationId, reference, qrToken }`. Erreurs : `409` plafond atteint, `409` déjà une réservation active, `403` non réservable / fermé.
- **`GET /me/tickets`** (auth USER) — chaque item porte `isReservation: boolean` ; pour une réservation, `qrStatus ∈ {RESERVED, USED, CANCELLED}`. Badge « Billet réservé » si `isReservation`. `GET /me/tickets/:id/qr-token` et `/download` résolvent aussi les réservations.
- **`POST /agents/scan`** (auth AGENT) — réservation : `{ reserved: true, reservationId, amount, currency, categoryName, holderName, holderPhone }` → pop-up jaune. Billet payé : vert inchangé.
- **`POST /agents/reservations/collect`** (auth AGENT) — body `{ qrToken }` → `{ status, amount, currency, holderName }` (Encaisser).
- **`POST /agents/reservations/delete`** (auth AGENT) — body `{ qrToken }` → `{ status }` (Supprimer, confirmation front).
- **`GET /events/:reference/scan-dashboard`** (auth USER) — + `reservations: { active, cap, collected, totalCollected, currency }`.

## Points reportés (spec §9, hors périmètre)

- OTP SMS du téléphone du porteur (fournisseur SMS requis).
- Cutoff d'expiration des réservations non honorées (sinon places bloquées).
- Email/notification de confirmation de réservation (le billet apparaît déjà dans « Mes billets »).
