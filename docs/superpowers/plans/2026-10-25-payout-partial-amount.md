# Retrait partiel « Réclamer le net » — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à l'organisateur de saisir le **montant** à retirer (retrait partiel), déduit du solde à la demande, avec un minimum par devise et une garantie serveur anti‑surfacturation (jamais plus que le solde réel).

**Architecture:** Le montant est fourni par le client mais **revalidé côté serveur dans la transaction verrouillée** (`pg_advisory_xact_lock`) : forme (positif, précision), minimum devise, et `≤ solde réel recalculé dans la tx`. Le ledger n'est débité que du montant validé. Le front ajoute un champ montant + bouton Max + gate minimum + un bouton OK qui réinitialise le formulaire après décision (confirmation ou rejet).

**Tech Stack:** Back NestJS/TypeScript/Prisma (Jest). Front React 18 + Vite + @tanstack/react-query (Vitest).

## Global Constraints

- **Commits : JAMAIS de ligne `Co-Authored-By`** (CLAUDE.md prime).
- **Aucune migration Prisma** : le modèle `PayoutClaim` porte déjà `amount`. Ne pas lancer `prisma migrate*`.
- **Ne jamais lancer `npm run lint`** (fait `--fix`) : vérifier avec `npx eslint <fichiers>` sans `--fix`.
- **Anti‑surfacturation (non négociable)** : toute validation dépendant du solde (`amount ≤ solde`) se fait **dans la transaction** via `tx.ledgerEntry.aggregate`. Échec → `BadRequestException` → rollback, **aucune déduction**.
- **Seuils** : `MIN_CLAIM_AMOUNT = { USD: 1, CDF: 2500 }`, minimum **par retrait** et condition d'accès.
- **Précision** : USD = 2 décimales max, CDF = entier (`quantize(amount, currency) === amount`).
- **Un seul retrait `SENT` à la fois** : conserver le fast‑path existant.
- Code et messages d'erreur **en français**.
- eslint back : code PROD = **0 erreur neuve** ; la dette `any` des specs existantes reste tolérée (le fichier spec en contient déjà).
- Back : `npx jest src/payments/payouts.service.spec.ts`. Front : `npx vitest run <fichier>`.

---

### Task 1 : Backend — montant partiel + validations anti‑surfacturation

**Files:**
- Modify: `src/common/constants.ts` (ajout `MIN_CLAIM_AMOUNT`)
- Modify: `src/payments/dto/claim-payout.dto.ts` (ajout `amount`)
- Modify: `src/payments/payouts.controller.ts` (passe `dto.amount`)
- Modify: `src/payments/payouts.service.ts` (signature `claimNet` + validations + retrait de la dépendance `EarningsService`)
- Test: `src/payments/payouts.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `MailService`, `JwtService`, `ConfigService`, `$Enums.Currency`, `MIN_CLAIM_AMOUNT`.
- Produces: `claimNet(userId: string, currency: $Enums.Currency, mmoNumber: string, amount: number): Promise<PayoutClaimView>` ; `PayoutClaimView` inchangé. Constructeur de `PayoutsService` devient `(prisma, mail, jwt, config)` — **4 arguments** (EarningsService retiré, car le solde est désormais recalculé dans la tx).

- [ ] **Step 1 : Ajouter la constante `MIN_CLAIM_AMOUNT`**

Dans `src/common/constants.ts`, ajouter (en important `$Enums` si absent) :

```ts
import { $Enums } from '@prisma/client';

// Montant minimum d'un retrait « Réclamer le net », PAR DEVISE. Sert à la fois de
// plancher par demande ET de condition d'accès (il faut au moins ça sur le compte).
export const MIN_CLAIM_AMOUNT: Record<$Enums.Currency, number> = {
  USD: 1,
  CDF: 2500,
};
```

- [ ] **Step 2 : Écrire/mettre à jour les tests `claimNet` (ils doivent échouer)**

Remplacer le haut du fichier `src/payments/payouts.service.spec.ts` (le bloc `build()` et le `describe('PayoutsService.claimNet')`) par la version ci‑dessous. Les autres `describe` (`resendClaim`, `getCurrentClaim`) restent inchangés **sauf** le `build()` partagé.

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';

const mail = { sendPayoutClaimEmail: jest.fn() };
const jwt = { sign: jest.fn(() => 'TK') };
const config = { get: jest.fn(() => 'https://api.test') };

function build() {
  const prisma: any = {
    payoutClaim: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    ledgerEntry: { create: jest.fn(), aggregate: jest.fn() },
    user: { findUnique: jest.fn() },
    $executeRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  const svc = new PayoutsService(prisma, mail as any, jwt as any, config as any);
  return { svc, prisma };
}

const USER = { id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null };

// Helper : fixe le solde réel recalculé DANS la transaction.
function setBalance(prisma: any, amount: number) {
  prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount } });
}

beforeEach(() => jest.clearAllMocks());

describe('PayoutsService.claimNet', () => {
  it('déduit le montant demandé et crée une réclamation SENT (partiel)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 50);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });

    const res = await svc.claimNet('u1', 'USD', '243810000000', 30);

    expect(prisma.payoutClaim.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: 30, currency: 'USD', status: 'SENT', userId: 'u1' }),
    }));
    expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ account: 'ORGANIZER', type: 'PAYOUT_ORGANIZER', amount: -30, currency: 'USD', userId: 'u1' }),
    }));
    expect(mail.sendPayoutClaimEmail).toHaveBeenCalledWith(expect.objectContaining({
      confirmUrl: expect.stringContaining('decision=confirm'),
      rejectUrl: expect.stringContaining('decision=reject'),
    }));
    expect(res).toMatchObject({ id: 'c1', status: 'SENT', amount: 30, currency: 'USD' });
  });

  it('accepte un montant égal au solde', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 30);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    await expect(svc.claimNet('u1', 'USD', 'x', 30)).resolves.toMatchObject({ amount: 30 });
    expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: -30 }) }));
  });

  it('refuse un montant supérieur au solde SANS aucune déduction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 10);
    prisma.user.findUnique.mockResolvedValue(USER);
    await expect(svc.claimNet('u1', 'USD', 'x', 20)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('refuse un montant sous le minimum (USD < 1) avant toute transaction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    await expect(svc.claimNet('u1', 'USD', 'x', 0.5)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('refuse une précision USD invalide (3 décimales)', async () => {
    const { svc } = build();
    await expect(svc.claimNet('u1', 'USD', 'x', 1.234)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuse un montant CDF non entier', async () => {
    const { svc } = build();
    await expect(svc.claimNet('u1', 'CDF', 'x', 2500.5)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuse un montant nul ou négatif', async () => {
    const { svc } = build();
    await expect(svc.claimNet('u1', 'USD', 'x', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.claimNet('u1', 'USD', 'x', -5)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepte le minimum exact (USD = 1)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 5);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 1, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    await expect(svc.claimNet('u1', 'USD', 'x', 1)).resolves.toMatchObject({ amount: 1 });
  });

  it('renvoie la réclamation active existante sans re-déduire', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ id: 'c0', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', createdAt: new Date() });
    const res = await svc.claimNet('u1', 'USD', '243810000000', 10);
    expect(res.id).toBe('c0');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
  });

  it('course : réclamation créée entre-temps → relue sous verrou, pas de double déduction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'cX', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    setBalance(prisma, 50);
    prisma.user.findUnique.mockResolvedValue(USER);

    const res = await svc.claimNet('u1', 'USD', '243810000000', 50);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(res.id).toBe('cX');
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
  });

  it('échec du mail après commit : pas de 500, la vue est renvoyée', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 50);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    mail.sendPayoutClaimEmail.mockRejectedValueOnce(new Error('smtp down'));

    const res = await svc.claimNet('u1', 'USD', 'x', 50);

    expect(prisma.ledgerEntry.create).toHaveBeenCalled();
    expect(res).toMatchObject({ id: 'c1', status: 'SENT', amount: 50 });
  });
});
```

> NOTE : dans le `describe('PayoutsService.resendClaim')` et `describe('PayoutsService.getCurrentClaim')` existants, le `build()` partagé est celui ci‑dessus (4 args). Ces deux `describe` ne changent pas autrement.

- [ ] **Step 3 : Lancer les tests → ils échouent**

Run: `npx jest src/payments/payouts.service.spec.ts`
Expected: FAIL (signature `claimNet` à 4 args inexistante / constructeur à 5 args).

- [ ] **Step 4 : Mettre à jour le DTO**

Dans `src/payments/dto/claim-payout.dto.ts` : mettre à jour le commentaire de classe (le montant est désormais fourni par le client mais revalidé serveur) et ajouter le champ `amount`. Remplacer `import { IsEnum, IsString, Matches }` par un import incluant `IsNumber` et `IsPositive`, puis ajouter :

```ts
  // Montant à retirer, saisi par le client. INDICATIF : le serveur revalide
  // (précision, minimum par devise, ≤ solde réel) DANS la transaction verrouillée.
  // Le client ne peut jamais réclamer plus que son solde ni sous le minimum.
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'Montant invalide.' })
  @IsPositive({ message: 'Le montant doit être positif.' })
  amount: number;
```

Et retirer/мettre à jour la phrase du commentaire d'en‑tête disant « Le MONTANT n'est jamais fourni par le client ».

- [ ] **Step 5 : Mettre à jour le contrôleur**

Dans `src/payments/payouts.controller.ts`, la route `claim` :

```ts
  @Post('claim')
  @HttpCode(200)
  async claim(@Req() req: AuthedRequest, @Body() dto: ClaimPayoutDto) {
    return this.payouts.claimNet(
      req.user.sub,
      dto.currency,
      dto.mmoNumber,
      dto.amount,
    );
  }
```

- [ ] **Step 6 : Réécrire `claimNet` dans le service**

Dans `src/payments/payouts.service.ts` :

1. Retirer l'import et l'injection d'`EarningsService` (constructeur à 4 args : `prisma, mail, jwt, config`). Ajouter l'import `MIN_CLAIM_AMOUNT` depuis `src/common/constants` et un helper `quantize` local.

En tête de fichier (après les imports existants) :

```ts
import { MIN_CLAIM_AMOUNT } from 'src/common/constants';

const round2 = (n: number) => Math.round(n * 100) / 100;
// Quantifie un montant dans sa devise : CDF entier, USD 2 décimales (miroir EarningsService).
const quantize = (n: number, currency: $Enums.Currency) =>
  currency === 'CDF' ? Math.round(n) : round2(n);
```

2. Remplacer la méthode `claimNet` par :

```ts
  async claimNet(
    userId: string,
    currency: $Enums.Currency,
    mmoNumber: string,
    amount: number,
  ): Promise<PayoutClaimView> {
    // Validation de FORME du montant (indépendante du solde) : rejet rapide, sans verrou.
    this.assertAmountShape(amount, currency);

    // Chemin rapide : réclamation active existante → pas de nouvelle déduction.
    const existing = await this.prisma.payoutClaim.findFirst({
      where: { userId, currency, status: 'SENT' },
    });
    if (existing) return this.toView(existing);

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const jti = randomUUID();
    const { claim, created } = await this.prisma.$transaction(async (tx) => {
      // Sérialise les demandes concurrentes de ce (user, devise) : empêche la
      // double déduction sur double-clic. Verrou relâché en fin de transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:${userId}:${currency}`}))`;
      const active = await tx.payoutClaim.findFirst({
        where: { userId, currency, status: 'SENT' },
      });
      if (active) return { claim: active, created: false };

      // ANTI-SURFACTURATION : solde réel recalculé DANS la transaction (source de
      // vérité = ledger ORGANIZER). Le montant demandé ne peut jamais le dépasser.
      const agg = await tx.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { userId, account: 'ORGANIZER', currency },
      });
      const balance = quantize(agg._sum.amount ?? 0, currency);
      if (amount > balance) {
        throw new BadRequestException(
          'Montant supérieur au solde disponible.',
        );
      }

      const c = await tx.payoutClaim.create({
        data: { userId, currency, amount, mmoNumber, jti, status: 'SENT' },
      });
      await tx.ledgerEntry.create({
        data: {
          account: 'ORGANIZER',
          userId,
          type: 'PAYOUT_ORGANIZER',
          amount: -amount, // débit : déduction du montant demandé
          currency,
        },
      });
      return { claim: c, created: true };
    });

    if (created) {
      const { confirmUrl, rejectUrl } = this.buildDecisionUrls(
        claim.id,
        claim.jti,
      );
      try {
        await this.mail.sendPayoutClaimEmail({
          user,
          currency,
          amount: claim.amount,
          mmoNumber,
          confirmUrl,
          rejectUrl,
        });
      } catch (e) {
        this.logger.error(
          `Envoi du mail de réclamation échoué (claim ${claim.id})`,
          e as Error,
        );
      }
    }

    this.logger.log(
      `Réclamation ${created ? 'créée' : 'déjà active'} (user ${userId}, ${claim.amount} ${currency})`,
    );
    return this.toView(claim);
  }

  // Validation de forme d'un montant de retrait, indépendante du solde.
  private assertAmountShape(amount: number, currency: $Enums.Currency): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Montant invalide.');
    }
    if (quantize(amount, currency) !== amount) {
      throw new BadRequestException(
        currency === 'CDF'
          ? 'Le montant en CDF doit être un entier.'
          : 'Le montant en USD ne peut avoir plus de 2 décimales.',
      );
    }
    if (amount < MIN_CLAIM_AMOUNT[currency]) {
      throw new BadRequestException(
        `Montant minimum : ${MIN_CLAIM_AMOUNT[currency]} ${currency}.`,
      );
    }
  }
```

> `toView`, `buildDecisionUrls`, `resendClaim`, `getCurrentClaim` restent inchangés. Vérifier qu'aucune autre ligne ne référence encore `this.earnings`.

- [ ] **Step 7 : Lancer les tests → ils passent**

Run: `npx jest src/payments/payouts.service.spec.ts`
Expected: PASS (tous les `describe` du fichier).

- [ ] **Step 8 : Build + lint ciblé**

Run: `npx tsc -p tsconfig.json --noEmit` (ou `npm run build`) — doit compiler (notamment `payments.module.ts` : `EarningsService` reste un provider pour `EarningsController`, seule l'injection dans `PayoutsService` disparaît ; aucune modif du module attendue — corriger si le build signale le contraire).
Run: `npx eslint src/payments/payouts.service.ts src/payments/payouts.controller.ts src/payments/dto/claim-payout.dto.ts src/common/constants.ts`
Expected: 0 erreur neuve sur ces fichiers PROD.

- [ ] **Step 9 : Commit**

```bash
git add src/common/constants.ts src/payments/dto/claim-payout.dto.ts src/payments/payouts.controller.ts src/payments/payouts.service.ts src/payments/payouts.service.spec.ts
git commit -m "feat(payout): retrait partiel avec montant saisi + garde-fous anti-surfacturation"
```

---

### Task 2 : Frontend — plomberie (payload montant + invalidation solde + validation lib)

**Files:**
- Modify: `src/types/api.ts` (`ClaimNetPayload.amount`)
- Modify: `src/lib/payments.ts` (`MIN_CLAIM`, `quantizeAmount`, `claimAmountError`)
- Modify: `src/hooks/queries/use-payouts.ts` (`useClaimNet` invalide le solde)
- Modify: `src/services/payouts.service.ts` (commentaire)
- Test: `src/lib/payments.test.ts`

**Interfaces:**
- Consumes: `PaymentCurrency` (`src/types/api.ts`), `formatMoneyIn` (`src/lib/payments.ts`), `queryKeys.earnings.summary` (`["earnings","summary"]`).
- Produces: `MIN_CLAIM: Record<PaymentCurrency, number>` ; `claimAmountError(raw: string, currency: PaymentCurrency, available: number): string | null` ; `ClaimNetPayload` gagne `amount: number` ; `useClaimNet` invalide `queryKeys.earnings.summary` au succès.

- [ ] **Step 1 : Ajouter `amount` au type `ClaimNetPayload`**

Dans `src/types/api.ts`, `ClaimNetPayload` (≈ ligne 608) :

```ts
export interface ClaimNetPayload {
  currency: PaymentCurrency;
  mmoNumber: string;
  amount: number; // montant demandé (indicatif ; revalidé serveur)
}
```

- [ ] **Step 2 : Écrire les tests de `claimAmountError` (ils échouent)**

Dans `src/lib/payments.test.ts`, ajouter un bloc (adapter l'import existant pour inclure `claimAmountError`, `MIN_CLAIM`) :

```ts
import { claimAmountError, MIN_CLAIM } from "@/lib/payments";

describe("claimAmountError", () => {
  it("rejette un montant vide ou non numérique", () => {
    expect(claimAmountError("", "USD", 50)).not.toBeNull();
    expect(claimAmountError("abc", "USD", 50)).not.toBeNull();
  });
  it("rejette <= 0", () => {
    expect(claimAmountError("0", "USD", 50)).not.toBeNull();
    expect(claimAmountError("-3", "USD", 50)).not.toBeNull();
  });
  it("rejette sous le minimum devise", () => {
    expect(claimAmountError("0.5", "USD", 50)).not.toBeNull();
    expect(claimAmountError("2000", "CDF", 10000)).not.toBeNull();
  });
  it("rejette une précision invalide", () => {
    expect(claimAmountError("1.234", "USD", 50)).not.toBeNull(); // 3 décimales
    expect(claimAmountError("2500.5", "CDF", 10000)).not.toBeNull(); // CDF non entier
  });
  it("rejette un montant supérieur au disponible", () => {
    expect(claimAmountError("60", "USD", 50)).not.toBeNull();
  });
  it("accepte un montant valide (min, partiel, = dispo)", () => {
    expect(claimAmountError("1", "USD", 50)).toBeNull();
    expect(claimAmountError("12.50", "USD", 50)).toBeNull();
    expect(claimAmountError("50", "USD", 50)).toBeNull();
    expect(claimAmountError("2500", "CDF", 10000)).toBeNull();
  });
  it("accepte la virgule comme séparateur décimal", () => {
    expect(claimAmountError("12,50", "USD", 50)).toBeNull();
  });
  it("expose les seuils attendus", () => {
    expect(MIN_CLAIM).toEqual({ USD: 1, CDF: 2500 });
  });
});
```

Run: `npx vitest run src/lib/payments.test.ts` → FAIL (exports inexistants).

- [ ] **Step 3 : Implémenter `MIN_CLAIM`, `quantizeAmount`, `claimAmountError`**

Dans `src/lib/payments.ts`, ajouter (en réutilisant `formatMoneyIn` déjà présent et `PaymentCurrency`) :

```ts
import type { PaymentCurrency } from "@/types/api";

// Montant minimum d'un retrait par devise (miroir du back MIN_CLAIM_AMOUNT).
export const MIN_CLAIM: Record<PaymentCurrency, number> = { USD: 1, CDF: 2500 };

// Quantifie un montant dans sa devise : CDF entier, USD 2 décimales.
export function quantizeAmount(n: number, currency: PaymentCurrency): number {
  return currency === "CDF" ? Math.round(n) : Math.round(n * 100) / 100;
}

// Valide un montant de retrait saisi. Renvoie un message d'erreur FR, ou null si valide.
// (Le serveur revalide de toute façon ; ceci n'est que l'UX.)
export function claimAmountError(
  raw: string,
  currency: PaymentCurrency,
  available: number,
): string | null {
  const amount = Number(raw.replace(",", ".").trim());
  if (!raw.trim() || !Number.isFinite(amount) || amount <= 0) {
    return "Saisis un montant valide.";
  }
  if (quantizeAmount(amount, currency) !== amount) {
    return currency === "CDF"
      ? "Le montant en CDF doit être un entier."
      : "2 décimales maximum.";
  }
  if (amount < MIN_CLAIM[currency]) {
    return `Minimum : ${formatMoneyIn(MIN_CLAIM[currency], currency)}.`;
  }
  if (amount > available) {
    return "Montant supérieur au solde disponible.";
  }
  return null;
}
```

> Si `src/types/api.ts` importe déjà depuis `@/lib/payments` (cycle), utiliser plutôt le type local `"USD" | "CDF"` au lieu d'importer `PaymentCurrency`. Vérifier qu'aucun cycle d'import n'est introduit (`npx tsc --noEmit`).

Run: `npx vitest run src/lib/payments.test.ts` → PASS.

- [ ] **Step 4 : `useClaimNet` invalide le solde au succès**

Dans `src/hooks/queries/use-payouts.ts`, importer `useQueryClient` et modifier `useClaimNet` :

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// ...
export function useClaimNet() {
  const qc = useQueryClient();
  return useMutation<PayoutClaim, ApiError, ClaimNetPayload>({
    mutationFn: (payload) => payoutsService.claimNet(payload),
    onSuccess: () => {
      // La demande déduit le solde côté serveur → rafraîchir « Disponible ».
      void qc.invalidateQueries({ queryKey: queryKeys.earnings.summary });
    },
  });
}
```

- [ ] **Step 5 : Commentaire du service**

Dans `src/services/payouts.service.ts`, mettre à jour le commentaire de `claimNet` : le montant n'est plus « recalculé côté serveur » mais **saisi par le client et revalidé serveur**. (Aucun changement de code : `api.post("/me/payouts/claim", payload)` envoie déjà `payload.amount`.)

- [ ] **Step 6 : tsc + lint + commit**

Run: `npx tsc --noEmit` → 0 erreur.
Run: `npx eslint src/lib/payments.ts src/hooks/queries/use-payouts.ts src/types/api.ts src/services/payouts.service.ts`
Expected: 0 erreur neuve.

```bash
git add src/types/api.ts src/lib/payments.ts src/lib/payments.test.ts src/hooks/queries/use-payouts.ts src/services/payouts.service.ts
git commit -m "feat(payout): plomberie front montant partiel (payload amount, validation, invalidation solde)"
```

---

### Task 3 : Frontend — champ montant + Max + gate minimum + OK réinitialise

**Files:**
- Modify: `src/components/vybe/ClaimNetSheet.tsx`
- Test: `src/components/vybe/ClaimNetSheet.test.tsx`

**Interfaces:**
- Consumes: `claimAmountError`, `MIN_CLAIM` (`@/lib/payments`), `useClaimNet`, `useResendClaim`, `useCurrentClaim`, `formatMoneyIn`, `normalizeMobileNumber`. Props inchangées : `{ currency, amount, onDone }` (pas de modif de `Wallet.tsx`).
- Produces: un `ClaimNetSheet` où le bouton OK (confirmation **et** rejet) réinitialise le formulaire via un flag local `dismissedId` + `onDone()` (refetch solde).

- [ ] **Step 1 : Mettre à jour les tests du composant (ils échouent)**

Dans `src/components/vybe/ClaimNetSheet.test.tsx`, ajouter/adapter des cas (garder les tests existants qui restent valides, adapter ceux qui envoyaient une réclamation sans montant). Cas à couvrir :

```ts
// 1. Gate minimum : solde < MIN → message « trop faible », pas de champ montant.
//    Rendu avec amount=0.5 (USD) → attendre un texte contenant "trop faible"
//    et l'absence du champ montant (placeholder "Montant").
// 2. Bouton désactivé tant que montant invalide : saisir numéro + cocher,
//    montant "60" alors que amount=50 → bouton "Réclamer le net" disabled +
//    message "supérieur au solde".
// 3. Bouton "Max" : cliquer → le champ montant vaut le solde disponible (ex. "50").
// 4. Soumission valide : amount=50, saisir montant "30", numéro valide, cocher,
//    cliquer → useClaimNet.mutateAsync appelé avec { currency:"USD", mmoNumber, amount:30 }.
//    (mock useClaimNet pour renvoyer un claim SENT { amount:30 } ; vérifier la barre
//    affiche "30".)
// 5. CONFIRMED → clic OK → le formulaire réapparaît (champ montant à nouveau visible)
//    ET onDone appelé. (mock useCurrentClaim data = claim CONFIRMED.)
// 6. CANCELLED → clic OK → formulaire réapparaît + onDone appelé.
// 7. CDF : saisir "2500.5" → bouton disabled (CDF entier).
```

Reprendre le style de mock du fichier existant (les hooks `useClaimNet` / `useResendClaim` / `useCurrentClaim` sont mockés). Pour les cas 5/6, `useCurrentClaim` renvoie `{ data: <claim terminé>, refetch: vi.fn() }` et après clic OK le flag local doit filtrer ce claim.

Run: `npx vitest run src/components/vybe/ClaimNetSheet.test.tsx` → FAIL.

- [ ] **Step 2 : Réécrire `ClaimNetSheet.tsx`**

Points d'implémentation (conserver la structure/visuel existants : encart d'avertissement numéro, barre de progression, « Renvoyer », états CONFIRMED/CANCELLED) :

1. Imports : ajouter `claimAmountError, MIN_CLAIM` depuis `@/lib/payments`.
2. Nouveaux états : `const [amountStr, setAmountStr] = useState("")` ; `const [dismissedId, setDismissedId] = useState<string | null>(null)`.
3. `tracked` filtre le claim « dismissé » :

```ts
const serverClaim =
  current.data && current.data.id !== dismissedId ? current.data : null;
const tracked: PayoutClaim | null = justSent ?? serverClaim;
```

4. Gate minimum (remplace `nothingToClaim`) :

```ts
const belowMin = amount < MIN_CLAIM[currency];
```

Dans le bloc formulaire, si `belowMin` (et pas de `tracked`) → afficher :
*« Solde trop faible pour un retrait (min {formatMoneyIn(MIN_CLAIM[currency], currency)}). »* et NE PAS afficher le champ montant / numéro.

5. Champ montant (au-dessus du numéro), avec bouton Max et aide :

```tsx
const amountErr = amountStr ? claimAmountError(amountStr, currency, amount) : null;
// ...
<div className="space-y-1">
  <div className="flex items-center justify-between">
    <label className="text-xs text-muted-foreground">
      Montant à retirer — Dispo : {formatMoneyIn(amount, currency)}
    </label>
    <button
      type="button"
      className="text-xs font-semibold text-primary"
      onClick={() => setAmountStr(String(amount))}
    >
      Max
    </button>
  </div>
  <input
    className="w-full rounded-xl border p-3"
    type="text"
    inputMode="decimal"
    placeholder={`Montant (min ${formatMoneyIn(MIN_CLAIM[currency], currency)})`}
    value={amountStr}
    onChange={(e) => setAmountStr(e.target.value)}
  />
  {amountErr && <p className="text-xs text-destructive">{amountErr}</p>}
</div>
```

6. Bouton « Réclamer le net » : `disabled={!confirmed || number.trim() === "" || amountStr.trim() === "" || amountErr !== null || claim.isPending}`.

7. `submit` passe le montant :

```ts
const amountNum = Number(amountStr.replace(",", "."));
const res = await claim.mutateAsync({ currency, mmoNumber: normalized, amount: amountNum });
setJustSent(res);
void current.refetch();
```

(garder la validation numéro existante ; ne pas soumettre si `claimAmountError` non nul — déjà couvert par le bouton disabled, mais revalider dans `submit` par sécurité.)

8. `reset()` pour le bouton OK (confirmation ET rejet) :

```ts
const reset = () => {
  if (tracked) setDismissedId(tracked.id);
  setJustSent(null);
  setAmountStr("");
  setNumber("");
  setConfirmed(false);
  setErr(null);
  onDone(); // refetch solde (prop Wallet)
};
```

Remplacer les deux `onClick={onDone}` des boutons OK (bloc CONFIRMED et bloc CANCELLED) par `onClick={reset}`.

> La prop `onDone` reste utilisée (dans `reset`) → pas de changement de `Wallet.tsx`.

- [ ] **Step 3 : Tests verts**

Run: `npx vitest run src/components/vybe/ClaimNetSheet.test.tsx` → PASS.

- [ ] **Step 4 : Non-régression Wallet + tsc + lint**

Run: `npx vitest run src/components/vybe/Wallet.test.tsx` → PASS (inchangé).
Run: `npx tsc --noEmit` → 0 erreur.
Run: `npx eslint src/components/vybe/ClaimNetSheet.tsx`
Expected: 0 erreur neuve.

- [ ] **Step 5 : Commit**

```bash
git add src/components/vybe/ClaimNetSheet.tsx src/components/vybe/ClaimNetSheet.test.tsx
git commit -m "feat(payout): champ montant + Max + gate minimum + OK réinitialise le formulaire"
```

---

## Notes d'exécution

- **Branches** : back `feat/payout-partial-amount` (déjà créée, contient la spec+plan). Front : créer `feat/payout-partial-amount` depuis `main` avant la Task 2.
- **Rien n'est poussé** : l'utilisateur pousse lui-même. Déploiement = back + front ensemble, aucune migration, aucune nouvelle variable d'env.
- **Suite complète en fin de parcours** : back `npx jest src/payments`, front `npx vitest run` (noter l'échec préexistant `EventDetails.test.tsx`, non lié).

## Self-Review (writing-plans)

1. **Couverture spec** : champ montant ✅ (T3) ; déduction du montant ✅ (T1) ; OK réinitialise ✅ (T3) ; seuil min par retrait + accès ✅ (T1 service + T3 gate) ; anti-surfacturation serveur dans la tx ✅ (T1 Step 6) ; USD décimales / CDF entier ✅ (T1 `assertAmountShape`, T2 `claimAmountError`) ; un seul à la fois ✅ (fast-path conservé) ; invalidation solde ✅ (T2 Step 4). Pas de migration ✅.
2. **Placeholders** : aucun — tout le code est fourni.
3. **Cohérence des types** : `claimNet(userId, currency, mmoNumber, amount)` identique côté controller (T1 Step 5) et tests (T1 Step 2) ; `ClaimNetPayload.amount` (T2) consommé par `submit` (T3) ; `claimAmountError`/`MIN_CLAIM` définis en T2, utilisés en T3 ; `queryKeys.earnings.summary` existant.
