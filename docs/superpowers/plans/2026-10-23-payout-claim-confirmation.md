# Réclamation de paiement — confirmation + barre de progression — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persister la réclamation « Réclamer le net », déduire le solde à la demande, confirmer/rejeter via magic-link dans le mail équipe, et afficher une barre de progression persistante côté client avec un bouton « Renvoyer ».

**Architecture:** Backend NestJS/Prisma : nouveau modèle `PayoutClaim` + enum de statut + écriture ledger `PAYOUT_ORGANIZER` signée. Service `PayoutsService` étendu (création qui déduit, resend, lecture courante) et nouveau `PayoutModerationService` (confirm/reject calqué sur `EventModerationService`), exposé par un controller **public** calqué sur `/events/moderate`. Frontend React/Vite : `ClaimNetSheet` passe d'un accusé statique à un suivi avec barre animée, polling React Query et reprise d'état.

**Tech Stack:** NestJS, Prisma (Postgres/Neon), @nestjs/jwt, Jest (back) ; React 18, Vite, @tanstack/react-query, Vitest + @testing-library/react (front).

## Global Constraints

- Commentaires et messages d'erreur en **français**.
- **Ne PAS ajouter de ligne `Co-Authored-By`** aux messages de commit (règle `CLAUDE.md`).
- **Montant jamais fourni par le client** : recalculé serveur depuis le ledger (`EarningsService`, source de vérité).
- Solde organisateur = `Σ(amount) WHERE userId=X AND account=ORGANIZER` — logique inchangée.
- `LedgerEntry.amount` est **signé** : crédit > 0, débit < 0.
- Imports absolus back via `src/...` ; front via alias `@/...`.
- Back branche : `feat/payout-claim-confirmation` (déjà créée depuis `main`). Front : créer `feat/payout-claim-confirmation` depuis `main` (Task 7).
- Tests back : `npx jest <fichier>` ; front : `npx vitest run <fichier>`.
- Migration Neon = base partagée → créer la migration mais l'appliquer avec précaution (ne pas lancer `migrate dev` sur une base partagée sans réconciliation ; cf. `docs/mise-en-prod.md`).

---

### Task 1 : Schéma Prisma — modèle PayoutClaim + enums + migration

**Files:**
- Modify: `prisma/schema.prisma` (enum `LedgerEntryType` ~305-309 ; modèle `User` ~14 ; ajout en fin de fichier)
- Migration: `prisma/migrations/<timestamp>_payout_claim/migration.sql`

**Interfaces:**
- Produces: modèle Prisma `PayoutClaim { id, userId, currency, amount, mmoNumber, status, jti, createdAt, lastSentAt, decidedAt }`, enum `PayoutClaimStatus { SENT, CONFIRMED, CANCELLED }`, valeur `LedgerEntryType.PAYOUT_ORGANIZER`, relation `User.payoutClaims`.

- [ ] **Step 1 : Ajouter la valeur d'enum `PAYOUT_ORGANIZER`**

Dans `enum LedgerEntryType` :

```prisma
enum LedgerEntryType {
  SALE_ORGANIZER   // crédit organisateur au PAID (+)
  SALE_PLATFORM    // crédit plateforme au PAID (+)
  REFUND_ORGANIZER // débit organisateur sur remboursement (-)
  PAYOUT_ORGANIZER // retrait organisateur : négatif = déduction à la demande, positif = restauration au rejet
}
```

- [ ] **Step 2 : Ajouter l'enum de statut + le modèle (fin de fichier)**

```prisma
// Statut d'une réclamation de retrait net (« Réclamer le net »).
enum PayoutClaimStatus {
  SENT       // demande envoyée, solde déjà déduit, en attente de l'équipe Vybe
  CONFIRMED  // l'équipe Vybe a confirmé l'envoi de l'argent (aucun effet ledger)
  CANCELLED  // l'équipe Vybe a rejeté → solde restauré par écriture inverse
}

// Réclamation de retrait MANUEL assisté. Persiste la demande (le solde est déduit
// dès la création) pour suivre son statut et permettre la confirmation par magic-link.
model PayoutClaim {
  id         String            @id @default(uuid())
  userId     String
  user       User              @relation(fields: [userId], references: [id])
  currency   Currency
  amount     Float             // montant figé au moment de la demande (= solde déduit)
  mmoNumber  String            // numéro Mobile Money de réception
  status     PayoutClaimStatus @default(SENT)
  jti        String            @unique // id du token magic-link (intégrité du lien)
  createdAt  DateTime          @default(now())
  lastSentAt DateTime          @default(now()) // dernier envoi du mail (cooldown « Renvoyer »)
  decidedAt  DateTime?         // posé au CONFIRMED / CANCELLED

  @@index([userId, currency, status]) // « réclamation active » par devise
  @@index([userId, createdAt])        // reprise / historique
}
```

- [ ] **Step 3 : Déclarer la relation inverse sur `User`**

Dans `model User { ... }`, ajouter avec les autres relations :

```prisma
  payoutClaims PayoutClaim[]
```

- [ ] **Step 4 : Créer le fichier de migration SQL à la main**

> On n'exécute PAS `prisma migrate dev` (base Neon partagée). On crée le dossier + SQL, puis on régénère le client. Remplacer `<timestamp>` par `date +%Y%m%d%H%M%S`.

Créer `prisma/migrations/<timestamp>_payout_claim/migration.sql` :

```sql
-- AlterEnum
ALTER TYPE "LedgerEntryType" ADD VALUE 'PAYOUT_ORGANIZER';

-- CreateEnum
CREATE TYPE "PayoutClaimStatus" AS ENUM ('SENT', 'CONFIRMED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PayoutClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "mmoNumber" TEXT NOT NULL,
    "status" "PayoutClaimStatus" NOT NULL DEFAULT 'SENT',
    "jti" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    CONSTRAINT "PayoutClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayoutClaim_jti_key" ON "PayoutClaim"("jti");
CREATE INDEX "PayoutClaim_userId_currency_status_idx" ON "PayoutClaim"("userId", "currency", "status");
CREATE INDEX "PayoutClaim_userId_createdAt_idx" ON "PayoutClaim"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "PayoutClaim" ADD CONSTRAINT "PayoutClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

- [ ] **Step 5 : Régénérer le client Prisma**

Run: `npx prisma generate`
Expected: « Generated Prisma Client » sans erreur ; `$Enums.PayoutClaimStatus` et `$Enums.LedgerEntryType.PAYOUT_ORGANIZER` deviennent disponibles.

- [ ] **Step 6 : Vérifier la compilation du schéma**

Run: `npx prisma validate`
Expected: « The schema at prisma/schema.prisma is valid 🚀 »

- [ ] **Step 7 : Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(payout): modèle PayoutClaim + statut + ledger PAYOUT_ORGANIZER"
```

---

### Task 2 : Mail équipe — boutons Confirmer / Rejeter

**Files:**
- Modify: `src/mail/mail.service.ts` (`sendPayoutClaimEmail` ~558-...)
- Test: `src/mail/mail.service.spec.ts` (créer un test ciblé si le fichier existe, sinon ajouter au plus proche)

**Interfaces:**
- Consumes: rien de Task 1.
- Produces: `MailService.sendPayoutClaimEmail(params)` accepte désormais `confirmUrl: string` et `rejectUrl: string` en plus des champs actuels, et rend 2 boutons `<a>` dans le HTML + les 2 URLs dans le `text`.

- [ ] **Step 1 : Écrire le test (le HTML contient les 2 liens)**

Dans `src/mail/mail.service.spec.ts`, ajouter (adapter l'instanciation du service au pattern du fichier — `ConfigService.get` mocké ; SendGrid mocké pour capter le message) :

```ts
it('sendPayoutClaimEmail rend les boutons Confirmer et Rejeter', async () => {
  const sent: any[] = [];
  // @ts-expect-error — on remplace l'envoi réel par une capture
  service['send'] = async (msg: any) => { sent.push(msg); };
  await service.sendPayoutClaimEmail({
    user: { id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null },
    currency: 'USD', amount: 42, mmoNumber: '243810000000',
    confirmUrl: 'https://api.test/payouts/decision?token=TK&decision=confirm',
    rejectUrl: 'https://api.test/payouts/decision?token=TK&decision=reject',
  });
  expect(sent).toHaveLength(1);
  expect(sent[0].html).toContain('decision=confirm');
  expect(sent[0].html).toContain('decision=reject');
  expect(sent[0].text).toContain('decision=reject');
});
```

> Si `MailService` n'expose pas de méthode `send` interne interceptable, mocker `@sendgrid/mail` en tête de fichier (`jest.mock('@sendgrid/mail', ...)`) et lire l'argument de `sgMail.send`. Reproduire le pattern déjà utilisé par les autres tests mail du repo.

- [ ] **Step 2 : Lancer le test, vérifier l'échec**

Run: `npx jest src/mail/mail.service.spec.ts -t "boutons Confirmer"`
Expected: FAIL (`confirmUrl` inconnu / html ne contient pas `decision=confirm`).

- [ ] **Step 3 : Étendre la signature + le HTML**

Dans `sendPayoutClaimEmail`, ajouter au type de `params` :

```ts
    confirmUrl: string;
    rejectUrl: string;
```

Ajouter dans le bloc `text` (après la ligne numéro MMO) :

```ts
        `\nConfirmer (argent envoyé) : ${params.confirmUrl}\n` +
        `Rejeter (restaurer le solde) : ${params.rejectUrl}\n`,
```

Dans le HTML, juste avant la fermeture du corps de carte, insérer les 2 boutons :

```ts
      `<table cellpadding="0" cellspacing="0" style="margin:24px auto 0;"><tr>
        <td style="padding:0 8px;">
          <a href="${params.confirmUrl}" style="display:inline-block;padding:14px 26px;border-radius:10px;font-weight:700;background:#1db954;color:#fff;text-decoration:none;">Confirmer l'envoi</a>
        </td>
        <td style="padding:0 8px;">
          <a href="${params.rejectUrl}" style="display:inline-block;padding:14px 26px;border-radius:10px;font-weight:700;background:#e0245e;color:#fff;text-decoration:none;">Rejeter</a>
        </td>
      </tr></table>
      <p style="color:#9aa0a6;font-size:12px;margin:16px 0 0;">Confirmer = l'argent a été envoyé (le solde du client est déjà déduit). Rejeter = restaure le solde du client (ex. mauvais numéro).</p>`
```

> Insérer ce fragment dans le template HTML existant au bon endroit (dans la table centrale, avant `</td></tr></table>` de clôture). Garder l'échappement déjà en place pour les champs utilisateur.

- [ ] **Step 4 : Lancer le test, vérifier le succès**

Run: `npx jest src/mail/mail.service.spec.ts -t "boutons Confirmer"`
Expected: PASS

- [ ] **Step 5 : Commit**

```bash
git add src/mail/mail.service.ts src/mail/mail.service.spec.ts
git commit -m "feat(payout): boutons magic-link Confirmer/Rejeter dans le mail équipe"
```

---

### Task 3 : PayoutsService — création qui déduit + resend + lecture courante

**Files:**
- Modify: `src/payments/payouts.service.ts`
- Modify: `src/payments/payouts.service.spec.ts` (réécrit : l'ancien testait le flux fire-and-forget)

**Interfaces:**
- Consumes: `PayoutClaim` (Task 1), `MailService.sendPayoutClaimEmail(..., confirmUrl, rejectUrl)` (Task 2).
- Produces:
  - `PayoutsService.claimNet(userId, currency, mmoNumber): Promise<PayoutClaimView>`
  - `PayoutsService.resendClaim(userId, claimId): Promise<{ ok: true }>`
  - `PayoutsService.getCurrentClaim(userId, currency): Promise<PayoutClaimView | null>`
  - type `PayoutClaimView = { id: string; status: $Enums.PayoutClaimStatus; amount: number; currency: $Enums.Currency; mmoNumber: string; createdAt: Date }`

- [ ] **Step 1 : Écrire les tests**

Remplacer le contenu de `src/payments/payouts.service.spec.ts` par (mocks Prisma/Earnings/Mail/Jwt/Config) :

```ts
import { BadRequestException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';

const earnings = { getSummary: jest.fn() };
const mail = { sendPayoutClaimEmail: jest.fn() };
const jwt = { sign: jest.fn(() => 'TK') };
const config = { get: jest.fn(() => 'https://api.test') };

function makePrisma() {
  return {
    payoutClaim: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    ledgerEntry: { create: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb(txOf(prismaRef.current))),
  } as any;
}
const prismaRef: { current: any } = { current: null };
function txOf(p: any) { return p; }

function build() {
  const prisma = makePrisma();
  prismaRef.current = prisma;
  const svc = new PayoutsService(prisma, earnings as any, mail as any, jwt as any, config as any);
  return { svc, prisma };
}

beforeEach(() => jest.clearAllMocks());

describe('PayoutsService.claimNet', () => {
  it('déduit le solde et crée une réclamation SENT', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    earnings.getSummary.mockResolvedValue({ balances: [{ currency: 'USD', balance: 50 }] });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null });
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: '243810000000', jti: 'J', createdAt: new Date() });

    const res = await svc.claimNet('u1', 'USD', '243810000000');

    expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ account: 'ORGANIZER', type: 'PAYOUT_ORGANIZER', amount: -50, currency: 'USD', userId: 'u1' }),
    }));
    expect(mail.sendPayoutClaimEmail).toHaveBeenCalledWith(expect.objectContaining({
      confirmUrl: expect.stringContaining('decision=confirm'),
      rejectUrl: expect.stringContaining('decision=reject'),
    }));
    expect(res).toMatchObject({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD' });
  });

  it('renvoie la réclamation active existante sans re-déduire', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ id: 'c0', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', createdAt: new Date() });
    const res = await svc.claimNet('u1', 'USD', '243810000000');
    expect(res.id).toBe('c0');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
  });

  it('refuse si aucun solde', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    earnings.getSummary.mockResolvedValue({ balances: [{ currency: 'USD', balance: 0 }] });
    await expect(svc.claimNet('u1', 'USD', '243810000000')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('PayoutsService.resendClaim', () => {
  it('refuse le renvoi avant 60 s (cooldown)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', lastSentAt: new Date() });
    await expect(svc.resendClaim('u1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renvoie le mail après le cooldown et met à jour lastSentAt', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', lastSentAt: new Date(Date.now() - 120_000) });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null });
    const res = await svc.resendClaim('u1', 'c1');
    expect(mail.sendPayoutClaimEmail).toHaveBeenCalled();
    expect(prisma.payoutClaim.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' }, data: { lastSentAt: expect.any(Date) } }));
    expect(res).toEqual({ ok: true });
  });
});

describe('PayoutsService.getCurrentClaim', () => {
  it('renvoie la plus récente réclamation de la devise', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ id: 'c1', status: 'CONFIRMED', amount: 10, currency: 'USD', mmoNumber: 'x', createdAt: new Date() });
    const res = await svc.getCurrentClaim('u1', 'USD');
    expect(res).toMatchObject({ id: 'c1', status: 'CONFIRMED' });
  });

  it('renvoie null quand aucune réclamation', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    expect(await svc.getCurrentClaim('u1', 'USD')).toBeNull();
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `npx jest src/payments/payouts.service.spec.ts`
Expected: FAIL (constructeur à 3 args, `resendClaim`/`getCurrentClaim` absents).

- [ ] **Step 3 : Réécrire le service**

Remplacer `src/payments/payouts.service.ts` par :

```ts
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { EarningsService } from './earnings.service';

const RESEND_COOLDOWN_MS = 60_000;

export interface PayoutClaimView {
  id: string;
  status: $Enums.PayoutClaimStatus;
  amount: number;
  currency: $Enums.Currency;
  mmoNumber: string;
  createdAt: Date;
}

// Retrait MANUEL assisté (V1). La réclamation est PERSISTÉE et le solde est déduit
// dès la demande (écriture ledger PAYOUT_ORGANIZER négative). L'équipe Vybe confirme
// (statut seulement) ou rejette (restaure le solde) via magic-link dans le mail.
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly earnings: EarningsService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async claimNet(
    userId: string,
    currency: $Enums.Currency,
    mmoNumber: string,
  ): Promise<PayoutClaimView> {
    // Une seule réclamation active par (user, devise) : on ne re-déduit jamais.
    const active = await this.prisma.payoutClaim.findFirst({
      where: { userId, currency, status: 'SENT' },
    });
    if (active) return this.toView(active);

    // Solde net réel dans CETTE devise (source de vérité = ledger ORGANIZER).
    const { balances } = await this.earnings.getSummary(userId);
    const bal = balances.find((b) => b.currency === currency);
    if (!bal || bal.balance <= 0) {
      throw new BadRequestException('Aucun solde à réclamer dans cette devise.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstname: true, lastname: true, email: true, phone: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const jti = randomUUID();
    const claim = await this.prisma.$transaction(async (tx) => {
      const c = await tx.payoutClaim.create({
        data: {
          userId,
          currency,
          amount: bal.balance,
          mmoNumber,
          jti,
          status: 'SENT',
        },
      });
      await tx.ledgerEntry.create({
        data: {
          account: 'ORGANIZER',
          userId,
          type: 'PAYOUT_ORGANIZER',
          amount: -bal.balance, // débit : déduction à la demande
          currency,
        },
      });
      return c;
    });

    const { confirmUrl, rejectUrl } = this.buildDecisionUrls(claim.id, claim.jti);
    await this.mail.sendPayoutClaimEmail({
      user,
      currency,
      amount: claim.amount,
      mmoNumber,
      confirmUrl,
      rejectUrl,
    });

    this.logger.log(
      `Réclamation créée (user ${userId}, ${claim.amount} ${currency}, MMO ${mmoNumber})`,
    );
    return this.toView(claim);
  }

  async resendClaim(userId: string, claimId: string): Promise<{ ok: true }> {
    const claim = await this.prisma.payoutClaim.findUnique({ where: { id: claimId } });
    if (!claim || claim.userId !== userId) {
      throw new NotFoundException('Réclamation introuvable.');
    }
    if (claim.status !== 'SENT') {
      throw new BadRequestException('Cette demande a déjà été traitée.');
    }
    if (Date.now() - claim.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new BadRequestException('Patiente une minute avant de renvoyer.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, firstname: true, lastname: true, email: true, phone: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const { confirmUrl, rejectUrl } = this.buildDecisionUrls(claim.id, claim.jti);
    await this.mail.sendPayoutClaimEmail({
      user,
      currency: claim.currency,
      amount: claim.amount,
      mmoNumber: claim.mmoNumber,
      confirmUrl,
      rejectUrl,
    });
    await this.prisma.payoutClaim.update({
      where: { id: claim.id },
      data: { lastSentAt: new Date() },
    });
    return { ok: true };
  }

  async getCurrentClaim(
    userId: string,
    currency: $Enums.Currency,
  ): Promise<PayoutClaimView | null> {
    const claim = await this.prisma.payoutClaim.findFirst({
      where: { userId, currency },
      orderBy: { createdAt: 'desc' },
    });
    return claim ? this.toView(claim) : null;
  }

  private buildDecisionUrls(claimId: string, jti: string) {
    const token = this.jwt.sign(
      { sub: claimId, type: 'payout-claim', jti },
      { expiresIn: '7d' },
    );
    const base = this.config.get<string>('API_BASE_URL') ?? '';
    const t = encodeURIComponent(token);
    return {
      confirmUrl: `${base}/payouts/decision?token=${t}&decision=confirm`,
      rejectUrl: `${base}/payouts/decision?token=${t}&decision=reject`,
    };
  }

  private toView(c: {
    id: string;
    status: $Enums.PayoutClaimStatus;
    amount: number;
    currency: $Enums.Currency;
    mmoNumber: string;
    createdAt: Date;
  }): PayoutClaimView {
    return {
      id: c.id,
      status: c.status,
      amount: c.amount,
      currency: c.currency,
      mmoNumber: c.mmoNumber,
      createdAt: c.createdAt,
    };
  }
}
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `npx jest src/payments/payouts.service.spec.ts`
Expected: PASS (7 tests).

- [ ] **Step 5 : Commit**

```bash
git add src/payments/payouts.service.ts src/payments/payouts.service.spec.ts
git commit -m "feat(payout): claimNet persiste+déduit, resend, getCurrentClaim"
```

---

### Task 4 : PayoutModerationService — confirm / reject

**Files:**
- Create: `src/payments/payout-moderation.service.ts`
- Test: `src/payments/payout-moderation.service.spec.ts`

**Interfaces:**
- Consumes: `PayoutClaim` (Task 1).
- Produces: `PayoutModerationService.decide(token: string, decision: 'confirm' | 'reject'): Promise<{ message: string }>`.

- [ ] **Step 1 : Écrire les tests**

Créer `src/payments/payout-moderation.service.spec.ts` :

```ts
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PayoutModerationService } from './payout-moderation.service';

const jwt = { verify: jest.fn() };
function makePrisma() {
  const prisma: any = {
    payoutClaim: { findUnique: jest.fn(), update: jest.fn() },
    ledgerEntry: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  return prisma;
}
function build() {
  const prisma = makePrisma();
  return { prisma, svc: new PayoutModerationService(jwt as any, prisma) };
}
beforeEach(() => jest.clearAllMocks());

it('confirm → CONFIRMED sans écriture ledger', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', userId: 'u1' });
  await svc.decide('TK', 'confirm');
  expect(prisma.payoutClaim.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED' }) }));
  expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
});

it('reject → CANCELLED + écriture ledger +montant (restaure)', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', userId: 'u1' });
  await svc.decide('TK', 'reject');
  expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ account: 'ORGANIZER', type: 'PAYOUT_ORGANIZER', amount: 50, currency: 'USD', userId: 'u1' }),
  }));
});

it('rejette un token déjà traité (status !== SENT)', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', status: 'CONFIRMED', amount: 50, currency: 'USD', userId: 'u1' });
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(ConflictException);
});

it('rejette un mauvais type de token', async () => {
  const { svc } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'event-moderation', jti: 'J' });
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(ForbiddenException);
});

it('rejette un token invalide', async () => {
  const { svc } = build();
  jwt.verify.mockImplementation(() => { throw new Error('bad'); });
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(UnauthorizedException);
});

it('claim introuvable → NotFound', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue(null);
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(NotFoundException);
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `npx jest src/payments/payout-moderation.service.spec.ts`
Expected: FAIL (module introuvable).

- [ ] **Step 3 : Écrire le service**

Créer `src/payments/payout-moderation.service.ts` :

```ts
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';

interface PayoutTokenPayload {
  sub: string;
  type: string;
  jti: string;
}

// Décision de l'équipe Vybe sur une réclamation de retrait, via magic-link du mail
// (calqué sur EventModerationService). Confirm = statut seulement ; Reject = statut
// + écriture ledger inverse qui restaure le solde du client.
@Injectable()
export class PayoutModerationService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async decide(
    token: string,
    decision: 'confirm' | 'reject',
  ): Promise<{ message: string }> {
    let payload: PayoutTokenPayload;
    try {
      payload = this.jwt.verify<PayoutTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Lien invalide ou expiré.');
    }
    if (payload.type !== 'payout-claim') {
      throw new ForbiddenException('Type de token non autorisé.');
    }

    const claim = await this.prisma.payoutClaim.findUnique({
      where: { id: payload.sub },
    });
    if (!claim) throw new NotFoundException('Réclamation introuvable.');
    if (claim.status !== 'SENT') {
      throw new ConflictException('Cette demande a déjà été traitée.');
    }

    const confirmed = decision === 'confirm';
    await this.prisma.$transaction(async (tx) => {
      await tx.payoutClaim.update({
        where: { id: claim.id },
        data: {
          status: confirmed ? 'CONFIRMED' : 'CANCELLED',
          decidedAt: new Date(),
        },
      });
      if (!confirmed) {
        // Restaure le solde : écriture inverse (crédit) du montant déduit.
        await tx.ledgerEntry.create({
          data: {
            account: 'ORGANIZER',
            userId: claim.userId,
            type: 'PAYOUT_ORGANIZER',
            amount: claim.amount,
            currency: claim.currency,
          },
        });
      }
    });

    return {
      message: confirmed
        ? 'Paiement confirmé. Le client en est informé.'
        : 'Demande rejetée. Le solde du client a été restauré.',
    };
  }
}
```

- [ ] **Step 4 : Lancer, vérifier le succès**

Run: `npx jest src/payments/payout-moderation.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5 : Commit**

```bash
git add src/payments/payout-moderation.service.ts src/payments/payout-moderation.service.spec.ts
git commit -m "feat(payout): PayoutModerationService confirm/reject (reject restaure le solde)"
```

---

### Task 5 : Controllers + DTO + câblage module

**Files:**
- Modify: `src/payments/payouts.controller.ts`
- Create: `src/payments/payout-moderation.controller.ts`
- Create: `src/payments/dto/payout-decision.dto.ts`
- Modify: `src/payments/payments.module.ts`

**Interfaces:**
- Consumes: `PayoutsService.{resendClaim,getCurrentClaim}` (Task 3), `PayoutModerationService.decide` (Task 4).
- Produces (routes HTTP) :
  - `POST /me/payouts/claim/:id/resend` (guardé USER) → `{ ok: true }`
  - `GET /me/payouts/claim/current?currency=` (guardé USER) → `PayoutClaimView | null`
  - `GET /payouts/decision?token=&decision=` (public) → page HTML
  - `POST /payouts/decision` (public, body `{ token, decision }`) → `{ message }`

- [ ] **Step 1 : Créer le DTO de décision**

Créer `src/payments/dto/payout-decision.dto.ts` :

```ts
import { IsIn, IsString } from 'class-validator';

// Corps de POST /payouts/decision (public, soumis par la page HTML du mail équipe).
export class PayoutDecisionDto {
  @IsString()
  token: string;

  @IsIn(['confirm', 'reject'], { message: 'Décision invalide.' })
  decision: 'confirm' | 'reject';
}
```

- [ ] **Step 2 : Étendre `PayoutsController`**

Remplacer `src/payments/payouts.controller.ts` par :

```ts
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { ClaimPayoutDto } from './dto/claim-payout.dto';
import { PayoutsService } from './payouts.service';

interface AuthedRequest {
  user: { sub: string };
}

// Retrait organisateur (manuel/assisté). Réservé aux USER. Scope strict au
// req.user.sub.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
@Controller('me/payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  // « Réclamer le net » : crée la réclamation (déduit le solde) et alerte Vybe.
  @Post('claim')
  @HttpCode(200)
  async claim(@Req() req: AuthedRequest, @Body() dto: ClaimPayoutDto) {
    return this.payouts.claimNet(req.user.sub, dto.currency, dto.mmoNumber);
  }

  // « Renvoyer » : ré-expédie le mail de la réclamation SENT (cooldown 60 s).
  @Post('claim/:id/resend')
  @HttpCode(200)
  async resend(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.payouts.resendClaim(req.user.sub, id);
  }

  // Réclamation courante de la devise (polling / reprise de la barre).
  @Get('claim/current')
  async current(
    @Req() req: AuthedRequest,
    @Query('currency') currency: $Enums.Currency,
  ) {
    return this.payouts.getCurrentClaim(req.user.sub, currency);
  }
}
```

- [ ] **Step 3 : Créer le controller public de décision**

Créer `src/payments/payout-moderation.controller.ts` (page HTML calquée sur `/events/moderate`) :

```ts
import { Body, Controller, Get, Header, Post, Query } from '@nestjs/common';
import { PayoutDecisionDto } from './dto/payout-decision.dto';
import { PayoutModerationService } from './payout-moderation.service';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// PUBLIC (aucun guard) : l'équipe Vybe décide depuis le mail. La page GET affiche
// un bouton qui POST (évite qu'un prefetch du client mail décide tout seul).
@Controller('payouts')
export class PayoutModerationController {
  constructor(private readonly moderation: PayoutModerationService) {}

  @Get('decision')
  @Header('Content-Type', 'text/html')
  @Header(
    'Content-Security-Policy',
    "default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  )
  decisionPage(
    @Query('token') token: string,
    @Query('decision') decision: string,
  ): string {
    const safe = decision === 'reject' ? 'reject' : 'confirm';
    const label = safe === 'confirm' ? 'CONFIRMER' : 'REJETER';
    const color = safe === 'confirm' ? '#1db954' : '#e0245e';
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><title>Retrait Vybe</title></head>
<body style="font-family:Arial,sans-serif;background:#0d0d0d;color:#fff;text-align:center;padding:60px;">
  <h1>Confirmer : ${label}</h1>
  <p>Confirmez votre décision sur cette réclamation de retrait.</p>
  <form method="POST" action="/payouts/decision">
    <input type="hidden" name="token" value="${escapeHtml(token)}"/>
    <input type="hidden" name="decision" value="${safe}"/>
    <button type="submit" style="padding:14px 28px;border:none;border-radius:10px;font-weight:700;cursor:pointer;background:${color};color:#fff;">
      Confirmer : ${label}
    </button>
  </form>
</body></html>`;
  }

  @Post('decision')
  async decisionPost(@Body() dto: PayoutDecisionDto) {
    return this.moderation.decide(dto.token, dto.decision);
  }
}
```

- [ ] **Step 4 : Câbler le module**

Dans `src/payments/payments.module.ts` : importer les 2 nouveautés et les déclarer.

```ts
import { PayoutModerationController } from './payout-moderation.controller';
import { PayoutModerationService } from './payout-moderation.service';
```

Ajouter `PayoutModerationController` à `controllers` et `PayoutModerationService` à `providers` :

```ts
  controllers: [
    PaymentsController,
    EarningsController,
    PayoutsController,
    PayoutModerationController,
  ],
```

```ts
    PayoutsService,
    PayoutModerationService,
```

- [ ] **Step 5 : Vérifier la compilation**

Run: `npm run build`
Expected: build Nest OK, aucune erreur TS.

- [ ] **Step 6 : Lancer toute la suite back**

Run: `npx jest`
Expected: PASS (toutes les suites vertes, dont les nouvelles).

- [ ] **Step 7 : Commit**

```bash
git add src/payments/payouts.controller.ts src/payments/payout-moderation.controller.ts src/payments/dto/payout-decision.dto.ts src/payments/payments.module.ts
git commit -m "feat(payout): routes resend/current + controller public de décision"
```

---

### Task 6 : Vérification backend de bout en bout (manuelle, sans commit)

**Files:** aucun (vérification).

- [ ] **Step 1 : Lancer la suite complète + lint**

Run: `npx jest && npx eslint src/payments`
Expected: tests verts ; lint sans erreur (⚠️ ne pas lancer `npm run lint` qui fait `--fix` et reformate en masse).

- [ ] **Step 2 : Vérifier les routes exposées au démarrage**

Run: `npm run start:dev` puis, dans les logs Nest, confirmer la présence de `Mapped {/me/payouts/claim/:id/resend, POST}`, `{/me/payouts/claim/current, GET}`, `{/payouts/decision, GET}`, `{/payouts/decision, POST}`. Couper ensuite (Ctrl-C).

---

### Task 7 : Front — types, service, hooks (nouvelle branche)

**Files:**
- Modify: `src/types/api.ts` (bloc claim ~606-618)
- Modify: `src/services/payouts.service.ts`
- Modify: `src/hooks/queries/keys.ts` (~33-36)
- Modify: `src/hooks/queries/use-payouts.ts`

> Travailler dans le dépôt `~/vybeFrontend`. **Créer d'abord la branche** :
> `git checkout main && git checkout -b feat/payout-claim-confirmation`

**Interfaces:**
- Produces (front) :
  - type `PayoutClaimStatus = "SENT" | "CONFIRMED" | "CANCELLED"`
  - interface `PayoutClaim { id; status: PayoutClaimStatus; amount; currency: PaymentCurrency; mmoNumber; createdAt }`
  - `payoutsService.claimNet(payload): Promise<PayoutClaim>`
  - `payoutsService.resendClaim(claimId): Promise<{ ok: true }>`
  - `payoutsService.getCurrentClaim(currency): Promise<PayoutClaim | null>`
  - `useClaimNet()`, `useResendClaim()`, `useCurrentClaim(currency, enabled)`
  - `queryKeys.payouts.currentClaim(currency)`

- [ ] **Step 1 : Types (`src/types/api.ts`)**

Remplacer le bloc `ClaimNetResponse` (~613-618) par :

```ts
/** Statut d'une réclamation de retrait net. */
export type PayoutClaimStatus = "SENT" | "CONFIRMED" | "CANCELLED";

/** Réclamation de retrait persistée (retour de POST /me/payouts/claim et de
 * GET /me/payouts/claim/current). Le solde est déjà déduit dès SENT. */
export interface PayoutClaim {
  id: string;
  status: PayoutClaimStatus;
  amount: number;
  currency: PaymentCurrency;
  mmoNumber: string;
  createdAt: string;
}
```

> `ClaimNetPayload` (~608-611) reste inchangé. Supprimer l'ancien `ClaimNetResponse`.

- [ ] **Step 2 : Service (`src/services/payouts.service.ts`)**

Dans l'import de types, remplacer `ClaimNetResponse` par `PayoutClaim`. Remplacer `claimNet` et ajouter les 2 méthodes :

```ts
  claimNet(payload: ClaimNetPayload): Promise<PayoutClaim> {
    return api.post<PayoutClaim>("/me/payouts/claim", payload);
  },

  // « Renvoyer » : ré-expédie le mail de la réclamation SENT (cooldown serveur 60 s).
  resendClaim(claimId: string): Promise<{ ok: true }> {
    return api.post<{ ok: true }>(
      `/me/payouts/claim/${encodeURIComponent(claimId)}/resend`,
      {},
    );
  },

  // Réclamation courante de la devise (polling / reprise). null si aucune.
  getCurrentClaim(currency: string, signal?: AbortSignal): Promise<PayoutClaim | null> {
    return api.get<PayoutClaim | null>(
      `/me/payouts/claim/current?currency=${encodeURIComponent(currency)}`,
      { signal },
    );
  },
```

- [ ] **Step 3 : Keys (`src/hooks/queries/keys.ts`)**

Dans l'objet `payouts`, ajouter :

```ts
    currentClaim: (currency: string) => ["payouts", "claim", "current", currency] as const,
```

- [ ] **Step 4 : Hooks (`src/hooks/queries/use-payouts.ts`)**

Dans l'import de types, remplacer `ClaimNetResponse` par `PayoutClaim`. Remplacer `useClaimNet` et ajouter les 2 hooks :

```ts
export function useClaimNet() {
  return useMutation<PayoutClaim, ApiError, ClaimNetPayload>({
    mutationFn: (payload) => payoutsService.claimNet(payload),
  });
}

// « Renvoyer » : ré-expédie le mail de réclamation.
export function useResendClaim() {
  return useMutation<{ ok: true }, ApiError, string>({
    mutationFn: (claimId) => payoutsService.resendClaim(claimId),
  });
}

// Réclamation courante : polling tant que SENT, arrêt dès la décision Vybe.
export function useCurrentClaim(currency: string, enabled: boolean) {
  return useQuery<PayoutClaim | null, ApiError>({
    queryKey: queryKeys.payouts.currentClaim(currency),
    queryFn: ({ signal }) => payoutsService.getCurrentClaim(currency, signal),
    enabled,
    refetchInterval: (query) =>
      query.state.data && query.state.data.status === "SENT" ? 3000 : false,
  });
}
```

- [ ] **Step 5 : Vérifier le typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: aucune erreur (les usages de `ClaimNetResponse` ont tous migré).

> Si `tsc` signale un usage résiduel de `ClaimNetResponse` ailleurs, le remplacer par `PayoutClaim`.

- [ ] **Step 6 : Commit**

```bash
git add src/types/api.ts src/services/payouts.service.ts src/hooks/queries/keys.ts src/hooks/queries/use-payouts.ts
git commit -m "feat(payout): types+service+hooks réclamation (resend, currentClaim)"
```

---

### Task 8 : Front — `ClaimNetSheet` barre de progression + renvoyer + reprise

**Files:**
- Modify: `src/components/vybe/ClaimNetSheet.tsx`
- Modify: `src/components/vybe/Wallet.test.tsx` (le mock de `use-payouts` doit exposer les nouveaux hooks)
- Create: `src/components/vybe/ClaimNetSheet.test.tsx`

**Interfaces:**
- Consumes: `useClaimNet`, `useResendClaim`, `useCurrentClaim`, type `PayoutClaim` (Task 7).

- [ ] **Step 1 : Écrire les tests du composant**

Créer `src/components/vybe/ClaimNetSheet.test.tsx` :

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ClaimNetSheet } from "@/components/vybe/ClaimNetSheet";

const claimMutate = vi.fn();
const resendMutate = vi.fn();
const useClaimNetMock = vi.fn();
const useResendClaimMock = vi.fn();
const useCurrentClaimMock = vi.fn();

vi.mock("@/hooks/queries/use-payouts", () => ({
  useClaimNet: () => useClaimNetMock(),
  useResendClaim: () => useResendClaimMock(),
  useCurrentClaim: (...a: unknown[]) => useCurrentClaimMock(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useClaimNetMock.mockReturnValue({ mutateAsync: claimMutate, isPending: false });
  useResendClaimMock.mockReturnValue({ mutateAsync: resendMutate, isPending: false });
  useCurrentClaimMock.mockReturnValue({ data: null });
});

describe("ClaimNetSheet", () => {
  it("affiche le formulaire quand aucune réclamation en cours", () => {
    render(<ClaimNetSheet currency="USD" amount={85} onDone={vi.fn()} />);
    expect(screen.getByText("Réclamer le net")).toBeInTheDocument();
  });

  it("montre la barre + bouton Renvoyer quand une réclamation est SENT", () => {
    useCurrentClaimMock.mockReturnValue({
      data: { id: "c1", status: "SENT", amount: 85, currency: "USD", mmoNumber: "x", createdAt: "" },
    });
    render(<ClaimNetSheet currency="USD" amount={85} onDone={vi.fn()} />);
    expect(screen.getByText("Demande envoyée")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Renvoyer/i })).toBeInTheDocument();
  });

  it("Renvoyer déclenche la mutation de renvoi", () => {
    useCurrentClaimMock.mockReturnValue({
      data: { id: "c1", status: "SENT", amount: 85, currency: "USD", mmoNumber: "x", createdAt: "" },
    });
    render(<ClaimNetSheet currency="USD" amount={85} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Renvoyer/i }));
    expect(resendMutate).toHaveBeenCalledWith("c1");
  });

  it("barre pleine + message quand CONFIRMED", () => {
    useCurrentClaimMock.mockReturnValue({
      data: { id: "c1", status: "CONFIRMED", amount: 85, currency: "USD", mmoNumber: "x", createdAt: "" },
    });
    render(<ClaimNetSheet currency="USD" amount={85} onDone={vi.fn()} />);
    expect(screen.getByText(/Confirmé/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Renvoyer/i })).not.toBeInTheDocument();
  });

  it("message de restauration quand CANCELLED", () => {
    useCurrentClaimMock.mockReturnValue({
      data: { id: "c1", status: "CANCELLED", amount: 85, currency: "USD", mmoNumber: "x", createdAt: "" },
    });
    render(<ClaimNetSheet currency="USD" amount={85} onDone={vi.fn()} />);
    expect(screen.getByText(/rejet|restauré/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2 : Lancer, vérifier l'échec**

Run: `npx vitest run src/components/vybe/ClaimNetSheet.test.tsx`
Expected: FAIL (le composant ne gère ni la barre ni les nouveaux hooks).

- [ ] **Step 3 : Réécrire `ClaimNetSheet.tsx`**

Remplacer `src/components/vybe/ClaimNetSheet.tsx` par :

```tsx
import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { normalizeMobileNumber, formatMoneyIn } from "@/lib/payments";
import {
  useClaimNet,
  useResendClaim,
  useCurrentClaim,
} from "@/hooks/queries/use-payouts";
import { ApiError } from "@/lib/api/client";
import type { PaymentCurrency, PayoutClaim } from "@/types/api";

/* Retrait MANUEL (V1) — « Réclamer le net » avec suivi.
 *
 * Le solde est déduit dès la demande (serveur). L'équipe Vybe confirme (barre
 * pleine) ou rejette (solde restauré) via magic-link. La barre reprend l'état
 * réel via useCurrentClaim (polling tant que SENT). */
export function ClaimNetSheet({
  currency,
  amount,
  onDone,
}: {
  currency: PaymentCurrency;
  amount: number;
  onDone: () => void;
}) {
  const claim = useClaimNet();
  const resend = useResendClaim();
  const current = useCurrentClaim(currency, true);

  const [number, setNumber] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Claim local juste après l'envoi (avant que le polling ne prenne le relais).
  const [justSent, setJustSent] = useState<PayoutClaim | null>(null);

  // Réclamation à suivre : la fraîche locale, sinon celle du serveur.
  const tracked: PayoutClaim | null = justSent ?? current.data ?? null;
  const inProgress = tracked?.status === "SENT";
  const isConfirmed = tracked?.status === "CONFIRMED";
  const isCancelled = tracked?.status === "CANCELLED";

  // Dès que le serveur renvoie une décision, on lâche l'état local.
  useEffect(() => {
    if (current.data && current.data.status !== "SENT") setJustSent(null);
  }, [current.data]);

  const nothingToClaim = amount <= 0 && !tracked;

  const submit = async () => {
    setErr(null);
    const normalized = normalizeMobileNumber(number);
    if (!normalized) {
      setErr("Numéro Mobile Money invalide (ex. 08XXXXXXXX).");
      return;
    }
    try {
      const res = await claim.mutateAsync({ currency, mmoNumber: normalized });
      setJustSent(res);
    } catch (e) {
      setErr(
        e instanceof ApiError ? e.userMessage : "Échec de l'envoi de ta demande.",
      );
    }
  };

  const doResend = async () => {
    if (!tracked) return;
    setErr(null);
    try {
      await resend.mutateAsync(tracked.id);
    } catch (e) {
      setErr(
        e instanceof ApiError ? e.userMessage : "Impossible de renvoyer pour l'instant.",
      );
    }
  };

  // ── Suivi (barre de progression) ────────────────────────────────────────
  if (tracked && (inProgress || isConfirmed)) {
    const pct = isConfirmed ? 100 : 50;
    return (
      <div className="p-4 rounded-2xl bg-card border border-border mb-5 space-y-4 text-center">
        <p className="text-sm">
          Retrait de <b>{formatMoneyIn(tracked.amount, tracked.currency)}</b>
        </p>

        {/* Ligne de progression : ~50% à l'envoi, 100% à la confirmation Vybe. */}
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-green-500 transition-[width] duration-700 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex justify-between text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground">Demande envoyée</span>
          <span className={isConfirmed ? "font-medium text-foreground" : ""}>
            {isConfirmed ? "Confirmé par Vybe" : "En attente de Vybe"}
          </span>
        </div>

        {isConfirmed ? (
          <div className="space-y-3">
            <p className="flex items-center justify-center gap-2 text-sm font-bold text-green-600">
              <CheckCircle2 className="w-5 h-5" /> Confirmé par Vybe
            </p>
            <Button className="rounded-xl" onClick={onDone}>OK</Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              L'équipe Vybe va vérifier et t'envoyer l'argent sur le numéro indiqué.
            </p>
            {err && <p className="text-sm text-destructive">{err}</p>}
            <Button
              variant="outline"
              className="rounded-xl"
              disabled={resend.isPending}
              onClick={doResend}
            >
              {resend.isPending ? "Renvoi…" : "Renvoyer le message"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  // ── Rejet : solde restauré ───────────────────────────────────────────────
  if (isCancelled) {
    return (
      <div className="p-4 rounded-2xl bg-card border border-border mb-5 text-center space-y-3">
        <p className="flex items-center justify-center gap-2 text-sm font-bold text-amber-600">
          <AlertTriangle className="w-5 h-5" /> Demande rejetée
        </p>
        <p className="text-sm text-muted-foreground">
          Ton solde a été restauré. Vérifie ton numéro et réessaie si besoin.
        </p>
        <Button className="rounded-xl" onClick={onDone}>OK</Button>
      </div>
    );
  }

  // ── Formulaire ───────────────────────────────────────────────────────────
  return (
    <div className="p-4 rounded-2xl bg-card border border-border mb-5 space-y-3">
      <p className="text-sm">
        Disponible : <b>{formatMoneyIn(amount, currency)}</b>
      </p>

      {nothingToClaim ? (
        <p className="text-xs text-muted-foreground">
          Aucun solde à réclamer pour le moment.
        </p>
      ) : (
        <>
          <div className="flex gap-2 p-3 rounded-xl bg-amber-50 border border-amber-300 text-amber-900">
            <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
            <p className="text-xs leading-relaxed">
              C'est sur <b>ce numéro</b> que Vybe enverra ton argent. Assure-toi
              qu'il est <b>correct, actif et à ta disposition</b> avant de valider.
              Si l'argent est envoyé vers un numéro erroné que tu as fourni sans
              avoir vérifié ces éléments, <b>Vybe ne peut en être tenue
              responsable</b>.
            </p>
          </div>

          <input
            className="w-full rounded-xl border p-3"
            type="tel"
            inputMode="numeric"
            placeholder="Numéro Mobile Money (ex. 08XXXXXXXX)"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />

          <label className="flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <span>
              Je confirme que ce numéro est correct et m'appartient, et j'accepte
              que Vybe ne soit pas responsable en cas de numéro erroné.
            </span>
          </label>

          {err && <p className="text-sm text-destructive">{err}</p>}

          <Button
            className="w-full rounded-xl"
            disabled={!confirmed || number.trim() === "" || claim.isPending}
            onClick={submit}
          >
            {claim.isPending ? "Envoi…" : "Réclamer le net"}
          </Button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 4 : Mettre à jour le mock de `Wallet.test.tsx`**

Le mock de `@/hooks/queries/use-payouts` n'expose que `useClaimNet` ; `ClaimNetSheet` appelle désormais aussi `useResendClaim` et `useCurrentClaim`. Remplacer le bloc de mock (~16-19) par :

```tsx
const useClaimNetMock = vi.fn();
vi.mock("@/hooks/queries/use-payouts", () => ({
  useClaimNet: () => useClaimNetMock(),
  useResendClaim: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCurrentClaim: () => ({ data: null }),
}));
```

- [ ] **Step 5 : Lancer les tests ciblés, vérifier le succès**

Run: `npx vitest run src/components/vybe/ClaimNetSheet.test.tsx src/components/vybe/Wallet.test.tsx`
Expected: PASS (les 5 nouveaux + Wallet inchangé vert).

- [ ] **Step 6 : Typecheck + suite complète front**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: aucune erreur TS ; toute la suite verte.

- [ ] **Step 7 : Commit**

```bash
git add src/components/vybe/ClaimNetSheet.tsx src/components/vybe/ClaimNetSheet.test.tsx src/components/vybe/Wallet.test.tsx
git commit -m "feat(payout): barre de progression + renvoyer + reprise dans ClaimNetSheet"
```

---

## Récapitulatif des livrables

| # | Dépôt | Livrable |
|---|---|---|
| 1 | back | schéma + migration `PayoutClaim` / enums / ledger |
| 2 | back | mail équipe : boutons Confirmer/Rejeter |
| 3 | back | `PayoutsService` : claimNet (déduit) / resend / getCurrentClaim |
| 4 | back | `PayoutModerationService` : confirm/reject (reject restaure) |
| 5 | back | controllers + DTO + câblage module |
| 6 | back | vérification E2E (routes, lint, suite) |
| 7 | front | types + service + hooks |
| 8 | front | `ClaimNetSheet` barre + renvoyer + reprise |

## Déploiement (hors plan, rappel)

- **Appliquer la migration** sur la base cible avec précaution (Neon partagée).
- **Déployer front + back ensemble** (contrat du claim modifié).
- `API_BASE_URL` déjà requis — rien de nouveau en env.
