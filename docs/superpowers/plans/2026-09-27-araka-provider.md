# Remplacement de PawaPay par ARAKA — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remplacer le fournisseur PawaPay par ARAKA (ProxyPay) pour l'achat et le retrait, sans rupture du contrat front, avec les verrous de sécurité V1–V8.

**Architecture:** Un `ArakaProvider` implémente l'interface existante `PaymentProvider` (token de login mis en cache, push `paymentrequest`, statut par référence agrégé, HMAC du callback, `sendmobilemoney`). Le contrat gagne l'extraction de référence du callback pour que les services ne connaissent plus aucun format fournisseur. Les verrous vivent dans `OrderService`, `PayoutsService`, le reaper et deux petits utilitaires (`operator-guards.ts`, `sliding-window-limiter.ts`).

**Tech Stack:** NestJS 11, TypeScript, Prisma/Postgres, Jest (backend `/Users/user/vybe`) ; React 18 + Vite + Vitest (front `/Users/user/vybeFrontend`).

**Spec :** `docs/superpowers/specs/2026-09-27-araka-provider-design.md`

## Global Constraints

- Commentaires et messages d'erreur **en français** (convention du repo).
- Références de transaction : **20 caractères max** (`VB` + 18 base32).
- Seul `APPROVED` vaut paiement / retrait réussi ; `ACCEPTED` = en cours.
- HTTP 500 / timeout / réseau côté ARAKA = **statut inconnu**, jamais `DECLINED`.
- `ARAKA_BASE_URL` doit commencer par `https://` (sinon refus de démarrer).
- Aucun log ne contient token, mot de passe ni numéro complet.
- Variables : `ARAKA_BASE_URL`, `ARAKA_EMAIL`, `ARAKA_PASSWORD`, `ARAKA_PAYMENT_PAGE_ID`, `ARAKA_CALLBACK_KEY`, `ARAKA_DISABLED_OPERATORS` (optionnelle).
- Codes opérateurs : `MPESA`, `ORANGE`, `AIRTEL`, `AFRIMONEY` (pas de retrait `AFRIMONEY`).
- Commits : **sans** ligne `Co-Authored-By` (CLAUDE.md). Ne pas pousser (l'utilisateur pousse lui-même).
- Lint : vérifier avec `npx eslint <fichiers>` (**jamais** `npm run lint`, qui fait `--fix` en masse).
- Pas de tunnel local (ngrok) : vérification par les tests puis sur staging Render.
- Migrations : SQL écrit à la main, appliqué par `prisma migrate deploy` (build Render) — **jamais** `prisma migrate dev` sur la base Neon partagée.
- Idempotence garantie côté Vybe (ARAKA ne déduplique pas) : I1 `Idempotency-Key` sur `POST /order`, I2 `jti` consommé via `UsedToken` au retrait.
- `@typescript-eslint/require-await` est actif : une méthode sans `await` ne doit pas être `async` (renvoyer `Promise.resolve(...)`).

---

### Task 0: Branche de travail (déjà en place)

La branche `feat/araka-provider` existe déjà : issue de `feat/payments`, elle porte la spec et ce plan. **Tout** le travail backend se fait dessus — jamais sur `main` ni sur `feat/payments`.

- [ ] **Step 1: Vérifier la branche**

Run: `git branch --show-current`
Expected: `feat/araka-provider`

- [ ] **Step 2: Vérifier que la suite part verte**

Run: `npm run test`
Expected: toutes les suites PASS.

---

### Task 1: Générateur de références courtes (20 caractères)

**Files:**
- Create: `src/common/transaction-ref.ts`
- Create: `src/common/transaction-ref.spec.ts`
- Modify: `src/orders/Order.service.ts:2` et `:87`
- Modify: `src/payments/payouts.service.ts:11` et `:147`

**Interfaces:**
- Produces: `newTransactionRef(): string` — `VB` + 18 caractères `[A-Z2-7]`.

- [ ] **Step 1: Écrire le test qui échoue**

`src/common/transaction-ref.spec.ts` :
```ts
import { newTransactionRef } from './transaction-ref';

describe('newTransactionRef', () => {
  it('20 caractères, préfixe VB, alphabet base32', () => {
    const ref = newTransactionRef();
    expect(ref).toHaveLength(20);
    expect(ref).toMatch(/^VB[A-Z2-7]{18}$/);
  });

  it('aucun doublon sur 10 000 tirages', () => {
    const refs = new Set(Array.from({ length: 10_000 }, () => newTransactionRef()));
    expect(refs.size).toBe(10_000);
  });
});
```

- [ ] **Step 2: Lancer le test, vérifier l'échec**

Run: `npx jest src/common/transaction-ref.spec.ts`
Expected: FAIL — `Cannot find module './transaction-ref'`.

- [ ] **Step 3: Implémenter**

`src/common/transaction-ref.ts` :
```ts
import { randomBytes } from 'crypto';

// Alphabet base32 (RFC 4648) : A-Z + 2-7, lisible et sans ambiguïté pour le support.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PREFIX = 'VB';
// 2 + 18 = 20 caractères : limite ARAKA de `transactionReference` (String(20)).
const RANDOM_LENGTH = 18;

// Référence de transaction partagée avec le fournisseur (paymentRef / payoutRef).
// ARAKA ne déduplique PAS les références : l'unicité repose sur ces ~90 bits
// d'aléa (18 × 5 bits) et sur le fait qu'on ne ré-initie jamais une référence.
export function newTransactionRef(): string {
  const bytes = randomBytes(RANDOM_LENGTH);
  let out = PREFIX;
  // 256 est multiple de 32 : `b & 31` reste uniforme.
  for (const b of bytes) out += BASE32[b & 31];
  return out;
}
```

- [ ] **Step 4: Remplacer `randomUUID()` dans les deux services**

`src/orders/Order.service.ts` — ligne 2 :
```ts
import { newTransactionRef } from "src/common/transaction-ref";
```
ligne 87 :
```ts
        const paymentRef = newTransactionRef();
```

`src/payments/payouts.service.ts` — supprimer `import { randomUUID } from 'crypto';` (ligne 11) et ajouter après les imports `src/common/...` :
```ts
import { newTransactionRef } from 'src/common/transaction-ref';
```
ligne 147 :
```ts
    const payoutRef = newTransactionRef();
```

- [ ] **Step 5: Lancer les tests concernés**

Run: `npx jest src/common/transaction-ref.spec.ts src/orders src/payments/payouts.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/common/transaction-ref.ts src/common/transaction-ref.spec.ts src/orders/Order.service.ts src/payments/payouts.service.ts
git commit -m "feat(paiement): références de transaction courtes (20 car.) pour ARAKA"
```

---

### Task 2: `ArakaProvider` (+ ajouts non cassants au contrat)

**Files:**
- Modify: `src/payments/payment-provider.interface.ts`
- Create: `src/payments/araka.provider.ts`
- Create: `src/payments/araka.provider.spec.ts`

**Interfaces:**
- Produces (contrat, ajouts **optionnels** à ce stade — rendus obligatoires en Task 3) :
  - `PaymentProvider.extractPaymentRef?(rawBody: string): string | undefined`
  - `PaymentProvider.extractPayoutRef?(rawBody: string): string | undefined`
  - `InitPaymentResult.providerTxnId?: string`
  - `CheckStatusResult.approvedCount?: number`
  - `ProviderOperator.payoutAvailable?: boolean`
  - `ProviderOperator.phonePrefixes?: string[]`
  - `class ProviderDeclinedError extends Error`
- Produces: `ArakaProvider` (constructeur `(config: ConfigService)`), constante exportée `ARAKA_OPERATORS`.

- [ ] **Step 1: Ajouts au contrat**

Dans `src/payments/payment-provider.interface.ts` :

Dans `InitPaymentResult`, après `paymentUrl?: string;` :
```ts
  // Identifiant de la transaction CHEZ le fournisseur (ARAKA : `transactionId`),
  // stocké dans Order.providerTxnId pour la réconciliation.
  providerTxnId?: string;
```

Dans `CheckStatusResult`, après `currency?: ProviderCurrency;` :
```ts
  // Nombre de transactions APPROVED sous la même référence (ARAKA ne déduplique
  // pas les références). > 1 = double débit → REVIEW côté service.
  approvedCount?: number;
```

Dans `ProviderOperator`, après `currencies: ProviderCurrency[];` :
```ts
  // L'opérateur accepte-t-il les décaissements (retraits) ? ARAKA : pas AFRIMONEY.
  payoutAvailable?: boolean;
  // Préfixes nationaux (après l'indicatif 243) des numéros de cet opérateur.
  // Absent = pas de contrôle de cohérence numéro ↔ opérateur.
  phonePrefixes?: string[];
```

Dans `PaymentProvider`, après `verifyWebhookSignature(...)` :
```ts
  // Extrait NOTRE référence (paymentRef / payoutRef) du corps brut d'un callback.
  // undefined = corps illisible ou référence absente.
  extractPaymentRef?(rawBody: string): string | undefined;
  extractPayoutRef?(rawBody: string): string | undefined;
```

Avant `export const PAYMENT_PROVIDER` :
```ts
// Refus EXPLICITE du fournisseur à l'initiation (rien n'a été créé chez lui).
// Toute AUTRE exception d'initPayment = issue inconnue (timeout, 500, réseau) :
// la transaction a pu être créée, le service ne doit pas conclure à l'échec.
export class ProviderDeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderDeclinedError';
  }
}
```

- [ ] **Step 2: Écrire le test qui échoue**

`src/payments/araka.provider.spec.ts` :
```ts
import { createHmac } from 'crypto';
import { ArakaProvider } from './araka.provider';
import { ProviderDeclinedError } from './payment-provider.interface';

// Réponse fetch factice façon Response (le provider lit `text()`).
function res(status: number, body?: unknown) {
  const text =
    body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(text),
  } as any;
}

// JWT non signé portant seulement `exp` (le provider ne vérifie pas la signature).
function jwtWithExp(expSeconds: number) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`;
}

const CONFIG: Record<string, string | undefined> = {
  ARAKA_BASE_URL: 'https://araka.test/api',
  ARAKA_EMAIL: 'api@vybe.test',
  ARAKA_PASSWORD: 'secret',
  ARAKA_PAYMENT_PAGE_ID: 'PAGE-1',
  ARAKA_CALLBACK_KEY: 'cb-key',
};

function makeProvider(over: Record<string, string | undefined> = {}) {
  const values = { ...CONFIG, ...over };
  return new ArakaProvider({ get: jest.fn((k: string) => values[k]) } as any);
}

const REF = 'VBAAAAAAAAAAAAAAAAAA';
const TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 7200);
const loginOk = (token = TOKEN) => res(200, { token, username: 'api@vybe.test' });

describe('ArakaProvider', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  describe('configuration', () => {
    it('V6 : ARAKA_BASE_URL en http:// → refus de démarrer', () => {
      expect(() => makeProvider({ ARAKA_BASE_URL: 'http://araka.test/api' })).toThrow(
        /https/,
      );
    });
  });

  describe('token', () => {
    it('login unique puis réutilisation du token', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(200, []));
      const p = makeProvider();
      await p.checkStatus(REF);
      await p.checkStatus(REF);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [loginUrl, loginOpts] = fetchMock.mock.calls[0];
      expect(loginUrl).toBe('https://araka.test/api/login');
      expect(JSON.parse(loginOpts.body)).toEqual({
        emailAddress: 'api@vybe.test',
        password: 'secret',
      });
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("re-login quand le token est à moins de 60 s de son expiration", async () => {
      const soon = jwtWithExp(Math.floor(Date.now() / 1000) + 30);
      fetchMock
        .mockResolvedValueOnce(loginOk(soon))
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(loginOk(soon))
        .mockResolvedValueOnce(res(200, []));
      const p = makeProvider();
      await p.checkStatus(REF);
      await p.checkStatus(REF);

      const urls = fetchMock.mock.calls.map((c) => c[0]);
      expect(urls.filter((u) => u.endsWith('/login'))).toHaveLength(2);
    });

    it('401 → re-login + un seul nouvel essai', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(401))
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, []));
      await expect(makeProvider().checkStatus(REF)).resolves.toEqual({ status: 'PENDING' });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('401 deux fois → exception', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(401))
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(401));
      await expect(makeProvider().checkStatus(REF)).rejects.toThrow(/authentification/);
    });

    it('login refusé → exception', async () => {
      fetchMock.mockResolvedValueOnce(res(401));
      await expect(makeProvider().checkStatus(REF)).rejects.toThrow(/login/);
    });
  });

  describe('initPayment', () => {
    const input = {
      paymentRef: REF,
      amount: 2500,
      currency: 'CDF' as const,
      operator: 'MPESA',
      phoneNumber: '243810000001',
      redirectUrl: 'https://api.vybe.test/payments/webhook',
    };

    it('POST /pay/paymentrequest : corps ARAKA exact + mode de callback HMAC', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(
        res(200, {
          transactionId: '128338',
          originatingTransactionId: REF,
          statusCode: '202',
          statusDescription: 'ACCEPTED',
        }),
      );
      const result = await makeProvider().initPayment(input);

      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toBe('https://araka.test/api/pay/paymentrequest');
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-API-CALLBACK-MODE']).toBe('2');
      expect(JSON.parse(opts.body)).toEqual({
        order: {
          paymentPageId: 'PAGE-1',
          transactionReference: REF,
          amount: 2500,
          currency: 'CDF',
          redirectURL: 'https://api.vybe.test/payments/webhook',
        },
        paymentChannel: {
          channel: 'MOBILEMONEY',
          provider: 'MPESA',
          walletID: '+243810000001',
        },
      });
      expect(result).toEqual({ paymentRef: REF, providerTxnId: '128338' });
    });

    it('HTTP 400 → ProviderDeclinedError', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(400, { statusCode: '400', statusDescription: 'DECLINED' }));
      await expect(makeProvider().initPayment(input)).rejects.toBeInstanceOf(
        ProviderDeclinedError,
      );
    });

    it('HTTP 200 mais statusCode 400 / DECLINED → ProviderDeclinedError', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, { statusCode: '400', statusDescription: 'DECLINED' }));
      await expect(makeProvider().initPayment(input)).rejects.toBeInstanceOf(
        ProviderDeclinedError,
      );
    });

    it('HTTP 500 → exception ordinaire (issue inconnue, PAS un refus)', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(res(500));
      const err = await makeProvider().initPayment(input).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ProviderDeclinedError);
    });

    it('timeout réseau → exception ordinaire (PAS un refus)', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
      const err = await makeProvider().initPayment(input).catch((e) => e);
      expect(err).not.toBeInstanceOf(ProviderDeclinedError);
    });
  });

  describe('checkStatus (transactionstatusbyreference)', () => {
    const item = (status: string, ref = REF) => ({
      transactionId: '1',
      status,
      transactionReference: ref,
      originatingTransactionId: ref,
    });

    it('interroge /reporting/transactionstatusbyreference/{ref}', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(res(200, []));
      await makeProvider().checkStatus(REF);
      expect(fetchMock.mock.calls[1][0]).toBe(
        `https://araka.test/api/reporting/transactionstatusbyreference/${REF}`,
      );
    });

    it.each([
      ['tableau vide', 200, [], { status: 'PENDING' }],
      ['un APPROVED', 200, [item('APPROVED')], { status: 'APPROVED', approvedCount: 1 }],
      [
        'deux APPROVED (double débit)',
        200,
        [item('APPROVED'), item('APPROVED')],
        { status: 'APPROVED', approvedCount: 2 },
      ],
      ['tous DECLINED', 200, [item('DECLINED'), item('DECLINED')], { status: 'DECLINED' }],
      ['DECLINED + ACCEPTED', 200, [item('DECLINED'), item('ACCEPTED')], { status: 'PENDING' }],
      ['ACCEPTED seul', 200, [item('ACCEPTED')], { status: 'PENDING' }],
      ['statut inconnu', 200, [item('WHATEVER')], { status: 'PENDING' }],
      [
        'objet unique (format du manuel, statusDescription)',
        200,
        { originatingTransactionId: REF, statusDescription: 'APPROVED' },
        { status: 'APPROVED', approvedCount: 1 },
      ],
      ['V5 : référence différente ignorée', 200, [item('APPROVED', 'AUTRE')], { status: 'PENDING' }],
      ['404 (référence inconnue)', 404, undefined, { status: 'PENDING' }],
    ])('%s', async (_label, httpStatus, body, expected) => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(res(httpStatus, body));
      await expect(makeProvider().checkStatus(REF)).resolves.toEqual(expected);
    });

    it('HTTP 500 → exception (statut inconnu, jamais DECLINED)', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(res(500));
      await expect(makeProvider().checkStatus(REF)).rejects.toThrow(/indisponible/);
    });

    it('checkPayoutStatus applique les mêmes règles', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, [item('APPROVED')]));
      await expect(makeProvider().checkPayoutStatus(REF)).resolves.toEqual({
        status: 'APPROVED',
        approvedCount: 1,
      });
    });
  });

  describe('verifyWebhookSignature (HMAC-SHA256 base64, X-APP-SIGNATURE)', () => {
    const body = JSON.stringify({ originatingTransactionId: REF, statusDescription: 'APPROVED' });
    const sign = (raw: string, key = 'cb-key') =>
      createHmac('sha256', key).update(raw, 'utf8').digest('base64');

    it('signature valide → true', () => {
      expect(makeProvider().verifyWebhookSignature(body, { 'x-app-signature': sign(body) })).toBe(
        true,
      );
    });
    it('corps altéré → false', () => {
      expect(
        makeProvider().verifyWebhookSignature(body + ' ', { 'x-app-signature': sign(body) }),
      ).toBe(false);
    });
    it('mauvaise clé → false', () => {
      expect(
        makeProvider().verifyWebhookSignature(body, { 'x-app-signature': sign(body, 'autre') }),
      ).toBe(false);
    });
    it('header absent → false', () => {
      expect(makeProvider().verifyWebhookSignature(body, {})).toBe(false);
    });
    it('signature de longueur différente → false (pas d’exception)', () => {
      expect(makeProvider().verifyWebhookSignature(body, { 'x-app-signature': 'AAAA' })).toBe(
        false,
      );
    });
    it('clé non configurée → false (fail-closed)', () => {
      expect(
        makeProvider({ ARAKA_CALLBACK_KEY: undefined }).verifyWebhookSignature(body, {
          'x-app-signature': sign(body),
        }),
      ).toBe(false);
    });
  });

  describe('extraction de référence du callback', () => {
    it('originatingTransactionId présent', () => {
      const raw = JSON.stringify({ transactionId: '1', originatingTransactionId: REF });
      expect(makeProvider().extractPaymentRef(raw)).toBe(REF);
      expect(makeProvider().extractPayoutRef(raw)).toBe(REF);
    });
    it('champ absent → undefined', () => {
      expect(makeProvider().extractPaymentRef('{"transactionId":"1"}')).toBeUndefined();
    });
    it('JSON illisible → undefined', () => {
      expect(makeProvider().extractPaymentRef('pas-du-json')).toBeUndefined();
    });
  });

  describe('getOperators', () => {
    it('liste fixe USD+CDF, AFRIMONEY sans retrait, préfixes exposés', async () => {
      const ops = await makeProvider().getOperators();
      expect(ops.map((o) => o.code)).toEqual(['MPESA', 'ORANGE', 'AIRTEL', 'AFRIMONEY']);
      for (const o of ops) {
        expect(o.available).toBe(true);
        expect(o.currencies).toEqual(['USD', 'CDF']);
      }
      expect(ops.find((o) => o.code === 'AFRIMONEY')!.payoutAvailable).toBe(false);
      expect(ops.find((o) => o.code === 'MPESA')!.payoutAvailable).toBe(true);
      expect(ops.find((o) => o.code === 'MPESA')!.phonePrefixes).toEqual(['81', '82', '83']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('V7 : ARAKA_DISABLED_OPERATORS grise les opérateurs listés', async () => {
      const ops = await makeProvider({ ARAKA_DISABLED_OPERATORS: ' orange, AIRTEL ' }).getOperators();
      const orange = ops.find((o) => o.code === 'ORANGE')!;
      expect(orange).toEqual(
        expect.objectContaining({ available: false, currencies: [], payoutAvailable: false }),
      );
      expect(ops.find((o) => o.code === 'AIRTEL')!.available).toBe(false);
      expect(ops.find((o) => o.code === 'MPESA')!.available).toBe(true);
    });
  });

  describe('initPayout (sendmobilemoney)', () => {
    const input = {
      payoutRef: REF,
      amount: 50,
      currency: 'USD' as const,
      operator: 'MPESA',
      phoneNumber: '243810000001',
    };

    it('200 SUCCESS → ACCEPTED (le reaper confirmera), corps exact', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(
        res(200, {
          transactionId: '999',
          originatingTransactionId: REF,
          statusCode: '200',
          statusDescription: 'SUCCESS',
        }),
      );
      const result = await makeProvider().initPayout(input);

      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toBe('https://araka.test/api/pay/sendmobilemoney');
      expect(JSON.parse(opts.body)).toEqual({
        order: { transactionReference: REF, amount: 50, currency: 'USD' },
        destination: { provider: 'MPESA', walletID: '+243810000001' },
      });
      expect(result).toEqual({ payoutRef: REF, providerPayoutId: '999', status: 'ACCEPTED' });
    });

    it('HTTP 400 → DECLINED', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(res(400, {}));
      await expect(makeProvider().initPayout(input)).resolves.toEqual(
        expect.objectContaining({ status: 'DECLINED' }),
      );
    });

    it('HTTP 500 → exception (le payout reste PENDING côté service)', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(res(500));
      await expect(makeProvider().initPayout(input)).rejects.toThrow();
    });

    it('AFRIMONEY (pas de retrait) → DECLINED sans aucun appel réseau', async () => {
      await expect(
        makeProvider().initPayout({ ...input, operator: 'AFRIMONEY' }),
      ).resolves.toEqual({ payoutRef: REF, status: 'DECLINED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 3: Lancer le test, vérifier l'échec**

Run: `npx jest src/payments/araka.provider.spec.ts`
Expected: FAIL — `Cannot find module './araka.provider'`.

- [ ] **Step 4: Implémenter le provider**

`src/payments/araka.provider.ts` :
```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  CheckStatusResult,
  InitPaymentInput,
  InitPaymentResult,
  InitPayoutInput,
  InitPayoutResult,
  PaymentProvider,
  ProviderDeclinedError,
  ProviderOperator,
} from './payment-provider.interface';

const HTTP_TIMEOUT_MS = 15_000;
// On renouvelle le token un peu AVANT son expiration réelle.
const TOKEN_SAFETY_MARGIN_MS = 60_000;
// Token sans `exp` lisible : durée de vie prudente (le token ARAKA dure 2 h).
const TOKEN_FALLBACK_TTL_MS = 110 * 60_000;

// Opérateurs ARAKA (codes de `paymentChannel.provider` / `destination.provider`).
// Préfixes = après l'indicatif 243 : usuels RDC, cohérents avec les numéros de test
// ARAKA — à confirmer par ProxyPay. AFRIMONEY n'est pas proposé en décaissement.
export const ARAKA_OPERATORS = [
  { code: 'MPESA', name: 'M-Pesa', phonePrefixes: ['81', '82', '83'], payout: true },
  { code: 'ORANGE', name: 'Orange Money', phonePrefixes: ['80', '84', '85', '89'], payout: true },
  { code: 'AIRTEL', name: 'Airtel Money', phonePrefixes: ['97', '98', '99'], payout: true },
  { code: 'AFRIMONEY', name: 'Afrimoney', phonePrefixes: ['90', '91'], payout: false },
] as const;

// Réponse (partielle) de paymentrequest / sendmobilemoney.
interface ArakaInitResponse {
  transactionId?: string;
  originatingTransactionId?: string;
  statusCode?: string;
  statusDescription?: string;
}

// Élément (partiel) de la réponse de transactionstatusbyreference. Le sandbox
// renvoie un TABLEAU d'éléments `status` ; le manuel documente un objet unique
// `statusDescription` : on accepte les deux formes.
interface ArakaStatusItem {
  transactionId?: string;
  status?: string;
  statusDescription?: string;
  transactionReference?: string;
  originatingTransactionId?: string;
}

interface ArakaHttpResult {
  status: number;
  body: unknown;
}

// Implémentation du PaymentProvider pour ARAKA (ProxyPay) — agrégateur Mobile Money
// RDC (M-Pesa, Orange, Airtel, Afrimoney). Modèle PUSH : on pousse la demande,
// l'acheteur valide par USSD/PIN, puis callback (HMAC) + re-vérification serveur
// par référence (source de vérité). Auth : POST /login → JWT Bearer de 2 h.
@Injectable()
export class ArakaProvider implements PaymentProvider {
  private readonly logger = new Logger(ArakaProvider.name);
  private readonly baseUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly paymentPageId: string;
  private readonly callbackKey: string;
  private readonly disabledOperators: Set<string>;
  private token?: string;
  private tokenExpiresAt = 0;

  constructor(private readonly config: ConfigService) {
    // Sans slash final : on concatène des chemins '/pay/...'.
    this.baseUrl = (this.config.get<string>('ARAKA_BASE_URL') ?? '').replace(/\/+$/, '');
    // V6 : identifiants marchands et token ne circulent JAMAIS en clair.
    if (this.baseUrl && !this.baseUrl.startsWith('https://')) {
      throw new Error('ARAKA_BASE_URL doit commencer par https:// (identifiants marchands).');
    }
    this.email = this.config.get<string>('ARAKA_EMAIL') ?? '';
    this.password = this.config.get<string>('ARAKA_PASSWORD') ?? '';
    this.paymentPageId = this.config.get<string>('ARAKA_PAYMENT_PAGE_ID') ?? '';
    this.callbackKey = this.config.get<string>('ARAKA_CALLBACK_KEY') ?? '';
    // V7 : interrupteur manuel (ex. "ORANGE,AIRTEL") pour griser un opérateur en panne.
    this.disabledOperators = new Set(
      (this.config.get<string>('ARAKA_DISABLED_OPERATORS') ?? '')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    );

    const missing = [
      'ARAKA_BASE_URL',
      'ARAKA_EMAIL',
      'ARAKA_PASSWORD',
      'ARAKA_PAYMENT_PAGE_ID',
    ].filter((k) => !this.config.get<string>(k));
    if (missing.length > 0) {
      // Pas de crash : les appels échoueront proprement (exception → compensation).
      this.logger.error(`Configuration ARAKA incomplète : ${missing.join(', ')} manquante(s).`);
    }
  }

  async initPayment(input: InitPaymentInput): Promise<InitPaymentResult> {
    if (!input.operator || !input.phoneNumber) {
      // Rien n'est envoyé : refus explicite (le service compense proprement).
      throw new ProviderDeclinedError('ARAKA : opérateur et numéro Mobile Money requis.');
    }
    const res = await this.request(
      'POST',
      '/pay/paymentrequest',
      {
        order: {
          paymentPageId: this.paymentPageId,
          transactionReference: input.paymentRef,
          amount: input.amount,
          currency: input.currency,
          redirectURL: input.redirectUrl,
        },
        paymentChannel: {
          channel: 'MOBILEMONEY',
          provider: input.operator,
          walletID: `+${input.phoneNumber}`,
        },
      },
      // Callback signé HMAC (header X-APP-SIGNATURE), cf. manuel ARAKA 2.2.2.
      { 'X-API-CALLBACK-MODE': '2' },
    );
    const body = (res.body ?? {}) as ArakaInitResponse;
    if (this.isExplicitRefusal(res.status, body)) {
      throw new ProviderDeclinedError(
        `ARAKA a refusé le paiement (HTTP ${res.status}) : ${body.statusDescription ?? 'sans détail'}.`,
      );
    }
    if (this.isSuccessHttp(res.status) && (body.statusCode === '202' || body.statusDescription === 'ACCEPTED')) {
      return { paymentRef: input.paymentRef, providerTxnId: body.transactionId };
    }
    // Issue inconnue : la transaction a PU être créée → exception ordinaire.
    throw new Error(
      `ARAKA : réponse inattendue à paymentrequest (HTTP ${res.status}, statusCode ${body.statusCode ?? '?'}).`,
    );
  }

  checkStatus(paymentRef: string): Promise<CheckStatusResult> {
    return this.statusByReference(paymentRef);
  }

  checkPayoutStatus(payoutRef: string): Promise<CheckStatusResult> {
    return this.statusByReference(payoutRef);
  }

  // HMAC-SHA256 (clé UTF-8) du corps BRUT, comparé en temps constant à
  // X-APP-SIGNATURE décodé en base64 (exemple C# `VerifyCallback` du manuel).
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
    if (!this.callbackKey) return false; // fail-closed tant que la clé n'est pas fournie
    const header = headers['x-app-signature'];
    if (!header) return false;
    const expected = createHmac('sha256', Buffer.from(this.callbackKey, 'utf8'))
      .update(rawBody, 'utf8')
      .digest();
    const received = Buffer.from(header, 'base64');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  extractPaymentRef(rawBody: string): string | undefined {
    return this.extractRef(rawBody);
  }

  extractPayoutRef(rawBody: string): string | undefined {
    return this.extractRef(rawBody);
  }

  // Pas d'endpoint d'état des opérateurs chez ARAKA : liste fixe + interrupteur V7.
  getOperators(): Promise<ProviderOperator[]> {
    return Promise.resolve(
      ARAKA_OPERATORS.map((op): ProviderOperator => {
        const disabled = this.disabledOperators.has(op.code);
        return {
          code: op.code,
          name: op.name,
          available: !disabled,
          currencies: disabled ? [] : ['USD', 'CDF'],
          payoutAvailable: !disabled && op.payout,
          phonePrefixes: [...op.phonePrefixes],
        };
      }),
    );
  }

  async initPayout(input: InitPayoutInput): Promise<InitPayoutResult> {
    const op = ARAKA_OPERATORS.find((o) => o.code === input.operator);
    if (!op || !op.payout || this.disabledOperators.has(input.operator)) {
      // Défense en profondeur (PayoutsService refuse déjà avant le débit) : rien n'est envoyé.
      return { payoutRef: input.payoutRef, status: 'DECLINED' };
    }
    const res = await this.request('POST', '/pay/sendmobilemoney', {
      order: {
        transactionReference: input.payoutRef,
        amount: input.amount,
        currency: input.currency,
      },
      destination: { provider: input.operator, walletID: `+${input.phoneNumber}` },
    });
    const body = (res.body ?? {}) as ArakaInitResponse;
    if (this.isExplicitRefusal(res.status, body)) {
      return { payoutRef: input.payoutRef, providerPayoutId: body.transactionId, status: 'DECLINED' };
    }
    const desc = (body.statusDescription ?? '').toUpperCase();
    if (
      this.isSuccessHttp(res.status) &&
      (body.statusCode === '200' || body.statusCode === '202' || desc === 'SUCCESS' || desc === 'ACCEPTED')
    ) {
      // 200 SUCCESS ne PROUVE PAS le crédit du destinataire : ACCEPTED, le reaper
      // confirme via checkPayoutStatus (source de vérité).
      return { payoutRef: input.payoutRef, providerPayoutId: body.transactionId, status: 'ACCEPTED' };
    }
    throw new Error(`ARAKA : réponse inattendue à sendmobilemoney (HTTP ${res.status}).`);
  }

  // ── Interne ────────────────────────────────────────────────────────────────

  // Agrège la réponse de transactionstatusbyreference (ARAKA ne déduplique pas les
  // références : plusieurs transactions possibles sous une même référence).
  private async statusByReference(ref: string): Promise<CheckStatusResult> {
    const res = await this.request(
      'GET',
      `/reporting/transactionstatusbyreference/${encodeURIComponent(ref)}`,
    );
    // Référence jamais vue par ARAKA (vérifié en sandbox) : en cours → le reaper
    // l'expirera au TTL.
    if (res.status === 404) return { status: 'PENDING' };
    if (!this.isSuccessHttp(res.status)) {
      // 500 & co : statut INCONNU, jamais un refus (une panne ne doit pas faire
      // échouer un paiement réussi).
      throw new Error(`ARAKA : statut indisponible pour ${ref} (HTTP ${res.status}).`);
    }
    const raw = res.body;
    const items: ArakaStatusItem[] = Array.isArray(raw)
      ? (raw as ArakaStatusItem[])
      : raw && typeof raw === 'object'
        ? [raw as ArakaStatusItem]
        : [];
    // V5 : seules les transactions portant EXACTEMENT notre référence comptent.
    const mine = items.filter(
      (it) => (it.originatingTransactionId ?? it.transactionReference) === ref,
    );
    if (mine.length !== items.length) {
      this.logger.warn(
        `ARAKA : ${items.length - mine.length} transaction(s) ignorée(s) (référence ≠ ${ref}).`,
      );
    }
    const statuses = mine.map((it) => (it.status ?? it.statusDescription ?? '').toUpperCase());
    const approvedCount = statuses.filter((s) => s === 'APPROVED').length;
    // Un débit confirmé est toujours honoré ; un refus n'est retenu que s'il est
    // explicite et unanime ; tout le reste (ACCEPTED, PENDING, inconnu) = en cours.
    if (approvedCount > 0) return { status: 'APPROVED', approvedCount };
    if (statuses.length > 0 && statuses.every((s) => s === 'DECLINED')) {
      return { status: 'DECLINED' };
    }
    return { status: 'PENDING' };
  }

  // Appel authentifié. Sur 401 : un seul re-login + nouvel essai (token révoqué ou
  // expiré plus tôt que prévu), puis exception.
  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ArakaHttpResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.getToken();
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (res.status === 401) {
        this.token = undefined; // force le re-login
        continue;
      }
      return { status: res.status, body: await this.readBody(res) };
    }
    throw new Error('ARAKA : authentification refusée après re-login.');
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const res = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailAddress: this.email, password: this.password }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ARAKA : login refusé (HTTP ${res.status}).`);
    const body = (await this.readBody(res)) as { token?: string } | undefined;
    if (!body?.token) throw new Error('ARAKA : login sans token.');
    this.token = body.token;
    this.tokenExpiresAt = this.tokenExpiry(body.token);
    return body.token;
  }

  // Expiration lue dans le claim `exp` du JWT (sans vérifier sa signature : on ne
  // s'en sert que pour savoir QUAND se reconnecter), moins une marge de sécurité.
  private tokenExpiry(token: string): number {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { exp?: unknown };
      if (typeof payload.exp === 'number') return payload.exp * 1000 - TOKEN_SAFETY_MARGIN_MS;
    } catch {
      // token opaque : durée par défaut ci-dessous
    }
    return Date.now() + TOKEN_FALLBACK_TTL_MS;
  }

  private async readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  private extractRef(rawBody: string): string | undefined {
    try {
      const body = JSON.parse(rawBody) as { originatingTransactionId?: unknown };
      return typeof body.originatingTransactionId === 'string' && body.originatingTransactionId
        ? body.originatingTransactionId
        : undefined;
    } catch {
      return undefined;
    }
  }

  private isSuccessHttp(status: number): boolean {
    return status >= 200 && status < 300;
  }

  // Refus EXPLICITE : HTTP 400/403, ou HTTP 2xx dont le corps dit 400/403/DECLINED.
  private isExplicitRefusal(status: number, body: ArakaInitResponse): boolean {
    if (status === 400 || status === 403) return true;
    return (
      this.isSuccessHttp(status) &&
      (body.statusCode === '400' ||
        body.statusCode === '403' ||
        (body.statusDescription ?? '').toUpperCase() === 'DECLINED')
    );
  }
}
```

- [ ] **Step 5: Lancer les tests, vérifier le succès**

Run: `npx jest src/payments/araka.provider.spec.ts`
Expected: PASS (tous les `describe`).

- [ ] **Step 6: Lint des fichiers touchés**

Run: `npx eslint src/payments/araka.provider.ts src/payments/araka.provider.spec.ts src/payments/payment-provider.interface.ts`
Expected: aucune erreur (des warnings `no-unsafe-*` dans le spec sont tolérés).

- [ ] **Step 7: Commit**

```bash
git add src/payments/araka.provider.ts src/payments/araka.provider.spec.ts src/payments/payment-provider.interface.ts
git commit -m "feat(paiement): ArakaProvider (login, paymentrequest, statut par référence, HMAC, sendmobilemoney)"
```

---

### Task 3: Bascule sur ARAKA, suppression de PawaPay

**Files:**
- Modify: `src/payments/payment-provider.interface.ts` (extract* obligatoires)
- Modify: `src/payments/payments.module.ts`
- Modify: `src/payments/payments.service.ts:51-87` (`handleWebhook`)
- Modify: `src/payments/payouts.service.ts` (`handlePayoutWebhook`)
- Modify: `src/payments/payments.service.spec.ts:1-139` (setup sur provider simulé)
- Modify: `src/payments/payouts.service.spec.ts` (mock + tests webhook)
- Modify: `src/common/constants.ts:91` (constante PawaPay supprimée)
- Delete: `src/payments/pawapay.provider.ts`, `src/payments/pawapay.provider.spec.ts`

**Interfaces:**
- Consumes: `ArakaProvider` (Task 2).
- Produces: `PaymentProvider.extractPaymentRef(rawBody): string | undefined` et `extractPayoutRef(rawBody)` **obligatoires**.

- [ ] **Step 1: Réécrire le setup de `payments.service.spec.ts` sur un provider simulé**

Remplacer les lignes 1 à 139 (imports → fin du `beforeEach`) par :
```ts
import { UnauthorizedException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PrismaService } from 'src/prisma/prisma.service';
import type {
  PaymentProvider,
  ProviderStatus,
} from './payment-provider.interface';

describe('PaymentsService.handleWebhook', () => {
  let service: PaymentsService;
  // Provider simulé : le service ne dépend que du contrat, jamais d'un fournisseur.
  let provider: {
    verifyWebhookSignature: jest.Mock;
    extractPaymentRef: jest.Mock;
    checkStatus: jest.Mock;
  };

  // Le client de transaction (tx) passé au callback de $transaction.
  let tx: {
    $executeRaw: jest.Mock;
    ticket: { createMany: jest.Mock };
    ledgerEntry: { createMany: jest.Mock };
    order: { update: jest.Mock; updateMany: jest.Mock };
  };
  let prisma: {
    paymentProviderLog: { create: jest.Mock };
    order: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const PAYMENT_REF = 'VBTESTREF00000000001';

  // Une commande PENDING par défaut (200 USD → org 170, fee 30, 2 billets).
  const order = (over: Partial<any> = {}) => ({
    id: 'order-1',
    paymentRef: PAYMENT_REF,
    ticketCategoryId: 'cat-1',
    quantity: 2,
    chargedAmount: 200,
    organizerAmount: 170,
    platformFee: 30,
    currency: 'USD',
    paymentStatus: 'PENDING',
    ticketCategory: {
      event: {
        id: 'ev-1',
        endDate: new Date('2027-01-01T00:00:00Z'),
        createdById: 'organizer-1',
      },
    },
    ...over,
  });

  // Callback ARAKA : notre référence dans originatingTransactionId, signature valide.
  const webhook = (ref = PAYMENT_REF) => ({
    rawBody: JSON.stringify({ originatingTransactionId: ref, statusDescription: 'APPROVED' }),
    headers: { 'x-app-signature': 'valid' },
  });

  // Statut normalisé renvoyé par checkStatus (source de vérité).
  const mockCheck = (
    status: ProviderStatus,
    amount?: number,
    currency: 'USD' | 'CDF' = 'USD',
  ) => provider.checkStatus.mockResolvedValue({ status, amount, currency });

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      ticket: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      order: {
        update: jest.fn().mockResolvedValue({}),
        // Par défaut la transition conditionnelle affecte 1 ligne (l'appelant fait
        // réellement passer la commande de PENDING à son état terminal).
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      paymentProviderLog: { create: jest.fn().mockResolvedValue({}) },
      order: {
        findMany: jest.fn().mockResolvedValue([order()]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    provider = {
      verifyWebhookSignature: jest.fn(
        (_raw: string, headers: Record<string, string>) => headers['x-app-signature'] === 'valid',
      ),
      extractPaymentRef: jest.fn((raw: string) => {
        try {
          return (JSON.parse(raw) as { originatingTransactionId?: string }).originatingTransactionId;
        } catch {
          return undefined;
        }
      }),
      checkStatus: jest.fn(),
    };
    service = new PaymentsService(
      prisma as unknown as PrismaService,
      provider as unknown as PaymentProvider,
    );
  });
```

- [ ] **Step 2: Traduire les appels PawaPay du reste du fichier**

Run :
```bash
perl -pi -e "s/mockCheck\('COMPLETED', '(\d+)'(, 'CDF')?\)/mockCheck('APPROVED', \$1\$2)/g; s/mockCheck\('FAILED'\)/mockCheck('DECLINED')/g; s/mockCheck\('PROCESSING'\)/mockCheck('PENDING')/g; s/expect\(fetchMock\)/expect(provider.checkStatus)/g; s/non payé \(PROCESSING\)/non payé (PENDING)/g; s/tardivement \(COMPLETED\)/tardivement (APPROVED)/g; s/en cours \(PROCESSING\)/en cours (PENDING)/g" src/payments/payments.service.spec.ts
```

Vérifier qu'il ne reste aucune trace PawaPay :

Run: `grep -n "fetchMock\|COMPLETED\|PROCESSING\|depositId\|PawaPay" src/payments/payments.service.spec.ts`
Expected: aucune sortie.

- [ ] **Step 3: Adapter les tests de webhook payout (`payouts.service.spec.ts`)**

Dans le `beforeEach`, ajouter au mock `provider` (après `verifyWebhookSignature`) :
```ts
      extractPayoutRef: jest.fn((raw: string) => {
        try {
          return (JSON.parse(raw) as { originatingTransactionId?: string }).originatingTransactionId;
        } catch {
          return undefined;
        }
      }),
```

Puis :
```bash
perl -pi -e 's/\{"payoutId":"ref"\}/{"originatingTransactionId":"ref"}/g; s/resolvePayout\(payoutId\)/resolvePayout(originatingTransactionId)/g; s/payoutId absent/référence absente/g' src/payments/payouts.service.spec.ts
```

- [ ] **Step 4: Rendre `extract*` obligatoires dans le contrat**

`src/payments/payment-provider.interface.ts` — remplacer :
```ts
  extractPaymentRef?(rawBody: string): string | undefined;
  extractPayoutRef?(rawBody: string): string | undefined;
```
par :
```ts
  extractPaymentRef(rawBody: string): string | undefined;
  extractPayoutRef(rawBody: string): string | undefined;
```

- [ ] **Step 5: Lancer les tests webhook, vérifier l'échec**

Run: `npx jest src/payments/payments.service.spec.ts src/payments/payouts.service.spec.ts`
Expected: FAIL — les services lisent encore `depositId` / `payoutId` (ex. « Référence de paiement absente du webhook »).

- [ ] **Step 6: Services — extraction via le provider**

`src/payments/payments.service.ts`, dans `handleWebhook`, remplacer le bloc « 2) Extraire NOTRE référence » (du `let parsed` jusqu'au `}` du `if (!paymentRef)`) par :
```ts
    // 2) Extraire NOTRE référence (format propre au fournisseur → provider).
    const paymentRef = this.payment.extractPaymentRef(rawBody);
    if (!paymentRef) {
      throw new BadRequestException(
        'Référence de paiement absente ou corps de webhook illisible.',
      );
    }
```

`src/payments/payouts.service.ts`, dans `handlePayoutWebhook`, remplacer le bloc `let parsed … return this.resolvePayout(parsed.payoutId);` par :
```ts
    const payoutRef = this.payment.extractPayoutRef(rawBody);
    if (!payoutRef) {
      throw new BadRequestException(
        'Référence de payout absente ou corps de webhook illisible.',
      );
    }
    return this.resolvePayout(payoutRef);
```
et mettre à jour son commentaire d'en-tête :
```ts
  // Callback payout (public, signé). Miroir de PaymentsService.handleWebhook.
  // Signature fail-closed via le provider ; extraction de NOTRE référence (payoutRef)
  // par le provider, puis résolution via checkPayoutStatus (source de vérité).
```

- [ ] **Step 7: Lier ARAKA et supprimer PawaPay**

`src/payments/payments.module.ts` : remplacer `import { PawaPayProvider } from './pawapay.provider';` par `import { ArakaProvider } from './araka.provider';`, `useClass: PawaPayProvider` par `useClass: ArakaProvider`, et le commentaire d'en-tête par :
```ts
// Module paiement. Le fournisseur concret (ArakaProvider) est lié au token
// d'injection PAYMENT_PROVIDER : tout le flux (createOrder, webhook, reaper,
// comptabilité, retraits) dépend de l'interface via ce token, jamais de
// l'implémentation → changer de fournisseur ne touche qu'à ce `useClass`.
//
// ConfigModule est global (identifiants ARAKA via ConfigService) ; PrismaModule
// fournit PrismaService (audit PaymentProviderLog). AuthModule fournit JwtService
// pour JwtAuthGuard/RolesGuard (EarningsController, PayoutsController).
```

Puis :
```bash
git rm src/payments/pawapay.provider.ts src/payments/pawapay.provider.spec.ts
```

`src/common/constants.ts` : supprimer la constante `PAWAPAY_OPERATORS_CACHE_TTL_MS` et son commentaire (ligne ~91, plus utilisée).

- [ ] **Step 8: Lancer toute la suite**

Run: `npm run test`
Expected: PASS. (`npx tsc --noEmit -p tsconfig.json` doit aussi passer : plus aucun import de `pawapay.provider`.)

- [ ] **Step 9: Commit**

```bash
git add -A src/payments src/common/constants.ts
git commit -m "feat(paiement): bascule sur ArakaProvider, suppression de PawaPay, référence du callback extraite par le provider"
```

---

### Task 4: Seul `APPROVED` vaut paiement ; double débit → `REVIEW`

**Files:**
- Modify: `src/payments/payments.service.ts` (`resolvePayment`)
- Modify: `src/payments/payouts.service.ts` (`resolvePayout`)
- Test: `src/payments/payments.service.spec.ts`, `src/payments/payouts.service.spec.ts`

**Interfaces:**
- Consumes: `CheckStatusResult.approvedCount` (Task 2).

- [ ] **Step 1: Écrire les tests qui échouent**

`src/payments/payments.service.spec.ts`, avant le `describe('resolvePayment (reaper, expireStale)'` :
```ts
  it('ACCEPTED (transaction non finalisée) → PENDING, jamais de billets', async () => {
    mockCheck('ACCEPTED', 200);
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ status: 'PENDING' }));
  });

  it('double débit (2 transactions APPROVED) → REVIEW, sans billets ni ledger', async () => {
    provider.checkStatus.mockResolvedValue({ status: 'APPROVED', approvedCount: 2 });
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { paymentRef: PAYMENT_REF, paymentStatus: { in: ['PENDING', 'EXPIRED'] } },
      data: { paymentStatus: 'REVIEW' },
    });
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ status: 'REVIEW' }));
  });
```

`src/payments/payouts.service.spec.ts`, dans `describe('resolvePayout'` :
```ts
    it('ACCEPTED (non finalisé) → reste PENDING, jamais COMPLETED', async () => {
      prisma.payout.findUnique.mockResolvedValue({ id: 'p1', payoutRef: 'ref', userId: 'org-1', currency: 'USD', amount: 50, status: 'PENDING' });
      provider.checkPayoutStatus.mockResolvedValue({ status: 'ACCEPTED' });
      const res = await service.resolvePayout('ref');
      expect(res.status).toBe('PENDING');
      expect(prisma.payout.update).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx jest src/payments/payments.service.spec.ts src/payments/payouts.service.spec.ts`
Expected: FAIL — ACCEPTED produit PAID / COMPLETED ; double débit produit PAID.

- [ ] **Step 3: Implémenter (`payments.service.ts`)**

Remplacer :
```ts
    // Ni approuvé ni refusé (PROCESSING/NOT_FOUND).
    if (check.status !== 'APPROVED' && check.status !== 'ACCEPTED') {
```
par :
```ts
    // Pas (encore) approuvé : ACCEPTED/PENDING = transaction en cours. ACCEPTED
    // n'a de sens qu'à l'initiation — ARAKA le renvoie aussi pour une transaction
    // non finalisée : JAMAIS considéré comme payé.
    if (check.status !== 'APPROVED') {
```

Juste après ce bloc (avant `// Approuvé : contrôle anti-divergence`), insérer :
```ts
    // Plusieurs transactions APPROVED sous la même référence = double débit de
    // l'acheteur : aucun billet automatique, régularisation manuelle.
    if ((check.approvedCount ?? 1) > 1) {
      await this.markReview(paymentRef);
      this.logger.warn(
        `Double débit détecté (paymentRef=${paymentRef}, ${check.approvedCount} transactions APPROVED) → REVIEW.`,
      );
      return { paymentRef, status: 'REVIEW' };
    }
```

Dans le bloc de divergence de montant, remplacer l'`updateMany` par `await this.markReview(paymentRef);`, puis ajouter la méthode privée (avant `private async log`) :
```ts
  // Résolution manuelle : les commandes non terminales du checkout passent REVIEW
  // (un paiement accepté ne reste jamais sans résolution, jamais de billet douteux).
  private async markReview(paymentRef: string): Promise<void> {
    await this.prisma.order.updateMany({
      where: { paymentRef, paymentStatus: { in: ['PENDING', 'EXPIRED'] } },
      data: { paymentStatus: 'REVIEW' },
    });
  }
```

- [ ] **Step 4: Implémenter (`payouts.service.ts`)**

Remplacer :
```ts
    if (check.status === 'APPROVED' || check.status === 'ACCEPTED') {
      // Déviation acceptée par rapport au chemin dépôt (qui route une divergence de
      // montant vers REVIEW) : ici le montant du payout est fixé côté serveur
      // (amount calculé par nos soins, pas saisi par l'acheteur), donc il n'y a pas
      // de divergence à arbitrer — APPROVED/ACCEPTED implique toujours COMPLETED.
```
par :
```ts
    if (check.status === 'APPROVED') {
      // Seul APPROVED prouve le crédit du destinataire (ACCEPTED = en cours). Pas
      // d'arbitrage de montant ici : il est fixé côté serveur (calculé par nos soins).
```

- [ ] **Step 5: Lancer, vérifier le succès**

Run: `npx jest src/payments`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/payments/payments.service.ts src/payments/payouts.service.ts src/payments/payments.service.spec.ts src/payments/payouts.service.spec.ts
git commit -m "fix(paiement): seul APPROVED vaut paiement/retrait réussi ; double débit → REVIEW"
```

---

### Task 5: V1 — initiation ambiguë ≠ échec ; `providerTxnId` ARAKA

**Files:**
- Modify: `src/orders/Order.service.ts` (bloc `initPayment` + `providerTxnId`)
- Test: `src/orders/Order.service.spec.ts`

**Interfaces:**
- Consumes: `ProviderDeclinedError`, `InitPaymentResult.providerTxnId` (Task 2).

- [ ] **Step 1: Écrire / adapter les tests**

`src/orders/Order.service.spec.ts` :

Ajouter à l'import de l'interface :
```ts
import { PaymentProvider, ProviderDeclinedError } from 'src/payments/payment-provider.interface';
```

Dans le `beforeEach`, mock d'init :
```ts
      initPayment: jest.fn().mockResolvedValue({ paymentRef: 'ignored', providerTxnId: 'provider-ref' }),
```

Remplacer le test `'échec init paiement → commandes FAILED + stock relâché + BadGatewayException'` par :
```ts
  it('refus explicite du fournisseur → commandes FAILED + stock relâché + 400', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category({ id: 'cat-1', name: 'Standard', price: 100 })]);
    provider.initPayment.mockRejectedValue(new ProviderDeclinedError('refusé'));

    await expect(
      service.createOrder('user-1', dto([{ ticketCategoryId: 'cat-1', quantity: 2 }])),
    ).rejects.toBeInstanceOf(BadRequestException);

    const ref = tx.order.create.mock.calls[0][0].data.paymentRef;
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentRef: ref },
      data: expect.objectContaining({ paymentStatus: 'FAILED' }),
    }));
    // 1 réservation + 1 relâchement.
    expect(tx.$executeRaw.mock.calls.length).toBeGreaterThan(1);
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
  });

  it('V1 : issue inconnue (timeout/500) → commandes laissées PENDING, stock NON relâché, réponse PENDING', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category({ id: 'cat-1', name: 'Standard', price: 100 })]);
    provider.initPayment.mockRejectedValue(new Error('timeout'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const res = await service.createOrder('user-1', dto([{ ticketCategoryId: 'cat-1', quantity: 2 }]));

    const ref = tx.order.create.mock.calls[0][0].data.paymentRef;
    expect(res).toEqual({ paymentRef: ref, currency: 'USD', chargedAmount: 200, status: 'PENDING' });
    expect(tx.order.updateMany).not.toHaveBeenCalled(); // aucune compensation FAILED
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1); // la seule réservation, aucun relâchement
  });
```

Retirer `BadGatewayException` de l'import `@nestjs/common` du spec s'il n'est plus utilisé.

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx jest src/orders/Order.service.spec.ts`
Expected: FAIL — le refus renvoie 502 (BadGateway) ; l'issue inconnue passe en FAILED ; `providerTxnId` vaut `'ignored'`.

- [ ] **Step 3: Implémenter**

`src/orders/Order.service.ts` — imports :
```ts
import { PAYMENT_PROVIDER, ProviderDeclinedError } from "src/payments/payment-provider.interface";
```
et retirer `BadGatewayException` de l'import `@nestjs/common` s'il n'est plus utilisé.

Remplacer le `catch { … throw new BadGatewayException(...) }` qui suit `initPayment` par :
```ts
        } catch (err) {
            if (!(err instanceof ProviderDeclinedError)) {
                // V1 : issue INCONNUE (timeout, 500, réseau). Le fournisseur a PU créer
                // la transaction et l'acheteur peut valider : on NE conclut PAS à
                // l'échec. Commandes laissées PENDING : le poll du front et le reaper
                // tranchent via checkStatus (référence inconnue → 404 → expirée au TTL).
                this.logger.error(`initPayment à l'issue inconnue (${paymentRef}), commandes laissées PENDING : ${String(err)}`);
                return { paymentRef, currency, chargedAmount: chargedTotal, status: 'PENDING' as const };
            }
            // Refus EXPLICITE : rien n'a été créé chez le fournisseur → compensation
            // (commandes FAILED + stock relâché, tout ou rien).
            await this.prisma.$transaction(async (tx) => {
                for (const line of lines) {
                    await tx.$executeRaw`
                    UPDATE "TicketCategory"
                    SET "soldCount" = "soldCount" - ${line.item.quantity}
                    WHERE "id" = ${line.item.ticketCategoryId}`;
                }
                await tx.order.updateMany({
                    where: { paymentRef },
                    data: { paymentStatus: 'FAILED' },
                });
            });
            throw new BadRequestException("Paiement refusé par l'opérateur. Vérifiez le numéro et l'opérateur, puis réessayez.");
        }
```

Et la trace fournisseur :
```ts
        // Identifiant de la transaction CHEZ le fournisseur (réconciliation).
        await this.prisma.order.updateMany({
            where: { paymentRef },
            data: { providerTxnId: initResult.providerTxnId ?? null },
        });
```
avec le type du résultat élargi :
```ts
        let initResult: { paymentRef: string; paymentUrl?: string; providerTxnId?: string };
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `npx jest src/orders/Order.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/orders/Order.service.ts src/orders/Order.service.spec.ts
git commit -m "fix(paiement): V1 — une initiation à l'issue inconnue laisse la commande PENDING (plus de débit sans billet) ; providerTxnId ARAKA"
```

---

### Task 6: V1 — garde-fou 24 h du reaper

**Files:**
- Modify: `src/common/constants.ts`
- Modify: `src/payments/payments.service.ts` (nouvelle méthode `expireUnresolved`)
- Modify: `src/payments/payments.cleanup.ts`
- Test: `src/payments/payments.cleanup.spec.ts`, `src/payments/payments.service.spec.ts`

**Interfaces:**
- Produces: `PaymentsService.expireUnresolved(paymentRef: string): Promise<void>` ; `PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS = 24`.

- [ ] **Step 1: Écrire les tests qui échouent**

`src/payments/payments.service.spec.ts`, à la fin du `describe` racine :
```ts
  describe('expireUnresolved (garde-fou V1)', () => {
    it('expire les commandes PENDING du checkout et relâche le stock', async () => {
      await service.expireUnresolved(PAYMENT_REF);
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: 'PENDING' },
        data: { paymentStatus: 'EXPIRED' },
      });
      expect(tx.$executeRaw).toHaveBeenCalled();
      expect(provider.checkStatus).not.toHaveBeenCalled();
    });
  });
```

`src/payments/payments.cleanup.spec.ts` : dans le `beforeEach`, `payments` devient :
```ts
    payments = {
      resolvePayment: jest
        .fn()
        .mockResolvedValue({ paymentRef: 'r', status: 'EXPIRED' }),
      expireUnresolved: jest.fn().mockResolvedValue(undefined),
    };
```
(et son type : `let payments: { resolvePayment: jest.Mock; expireUnresolved: jest.Mock };`), puis ajouter :
```ts
  it('V1 : statut toujours introuvable au-delà de 24 h → expireUnresolved', async () => {
    const old = new Date(Date.now() - 25 * 3_600_000);
    prisma.order.findMany.mockResolvedValue([{ paymentRef: 'r1', createdAt: old }]);
    payments.resolvePayment.mockRejectedValue(new Error('ARAKA 500'));

    await service.reapExpiredPayments();

    expect(payments.expireUnresolved).toHaveBeenCalledWith('r1');
  });

  it('V1 : statut introuvable depuis moins de 24 h → on attend (pas d’expiration forcée)', async () => {
    const recent = new Date(Date.now() - 2 * 3_600_000);
    prisma.order.findMany.mockResolvedValue([{ paymentRef: 'r1', createdAt: recent }]);
    payments.resolvePayment.mockRejectedValue(new Error('ARAKA 500'));

    await service.reapExpiredPayments();

    expect(payments.expireUnresolved).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx jest src/payments/payments.cleanup.spec.ts src/payments/payments.service.spec.ts`
Expected: FAIL — `expireUnresolved` n'existe pas / n'est pas appelé.

- [ ] **Step 3: Implémenter**

`src/common/constants.ts`, après `PAYMENT_PENDING_TTL_MINUTES` :
```ts
// Garde-fou V1 : un checkout PENDING dont le statut reste introuvable (erreurs
// fournisseur persistantes) au-delà de cette limite est expiré (stock relâché ;
// un paiement tardif reste ré-honorable).
export const PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS = 24;
```

`src/payments/payments.service.ts`, après `resolvePayment` :
```ts
  // Garde-fou V1 (reaper) : expire un checkout dont le statut fournisseur reste
  // introuvable au-delà de la limite dure. EXPIRED (≠ FAILED) : fulfill() pourra
  // encore ré-honorer un paiement confirmé tardivement.
  async expireUnresolved(paymentRef: string): Promise<void> {
    const orders = (await this.prisma.order.findMany({
      where: { paymentRef },
      include: { ticketCategory: { include: { event: true } } },
    })) as unknown as OrderWithEvent[];
    await this.expire(orders);
  }
```

`src/payments/payments.cleanup.ts` : importer `PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS` à côté de `PAYMENT_PENDING_TTL_MINUTES`, sélectionner aussi `createdAt` :
```ts
      select: { paymentRef: true, createdAt: true },
```
et remplacer la boucle par :
```ts
    const hardLimit = new Date(
      Date.now() - PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS * 3_600_000,
    );
    for (const { paymentRef, createdAt } of stale) {
      if (!paymentRef) continue;
      try {
        const res = await this.payments.resolvePayment(paymentRef, {
          expireStale: true,
        });
        this.logger.log(`Reaper paiement : ${paymentRef} → ${res.status}`);
      } catch (err) {
        // Un échec sur un checkout ne doit pas interrompre le balayage des autres.
        this.logger.warn(
          `Reaper paiement : échec sur ${paymentRef}: ${String(err)}`,
        );
        // V1 : statut introuvable depuis trop longtemps → on libère le stock.
        if (createdAt < hardLimit) {
          try {
            await this.payments.expireUnresolved(paymentRef);
            this.logger.error(
              `Reaper paiement : ${paymentRef} expiré après ${PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS} h sans statut fournisseur.`,
            );
          } catch (expireErr) {
            this.logger.warn(
              `Reaper paiement : expiration forcée impossible pour ${paymentRef}: ${String(expireErr)}`,
            );
          }
        }
      }
    }
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `npx jest src/payments`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/common/constants.ts src/payments/payments.service.ts src/payments/payments.cleanup.ts src/payments/payments.service.spec.ts src/payments/payments.cleanup.spec.ts
git commit -m "feat(paiement): V1 — le reaper expire un checkout sans statut fournisseur au-delà de 24 h"
```

---

### Task 7: V4 préfixe ↔ opérateur, V8 opérateur de retrait, DTO resserrée

**Files:**
- Create: `src/payments/operator-guards.ts`
- Create: `src/payments/operator-guards.spec.ts`
- Modify: `src/orders/Order.service.ts` (après la garde opérateur/devise)
- Modify: `src/orders/dto/CreateOrder.dto.ts:25-36`
- Modify: `src/payments/payouts.service.ts` (`requestPayout`)
- Test: `src/orders/Order.service.spec.ts`, `src/payments/payouts.service.spec.ts`

**Interfaces:**
- Consumes: `ProviderOperator.phonePrefixes`, `ProviderOperator.payoutAvailable` (Task 2).
- Produces: `assertPhoneMatchesOperator(op: ProviderOperator, phoneNumber: string): void` (lève `BadRequestException`).

- [ ] **Step 1: Écrire le test unitaire qui échoue**

`src/payments/operator-guards.spec.ts` :
```ts
import { BadRequestException } from '@nestjs/common';
import { assertPhoneMatchesOperator } from './operator-guards';

const mpesa = {
  code: 'MPESA',
  name: 'M-Pesa',
  available: true,
  currencies: ['USD', 'CDF'] as ('USD' | 'CDF')[],
  phonePrefixes: ['81', '82', '83'],
};

describe('assertPhoneMatchesOperator (V4)', () => {
  it('numéro M-Pesa (243 81…) avec MPESA → OK', () => {
    expect(() => assertPhoneMatchesOperator(mpesa, '243810000001')).not.toThrow();
  });

  it('numéro Airtel (243 97…) avec MPESA → 400', () => {
    expect(() => assertPhoneMatchesOperator(mpesa, '243970000001')).toThrow(BadRequestException);
  });

  it('opérateur sans préfixes connus → pas de contrôle', () => {
    expect(() =>
      assertPhoneMatchesOperator({ ...mpesa, phonePrefixes: undefined }, '243970000001'),
    ).not.toThrow();
  });
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx jest src/payments/operator-guards.spec.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter**

`src/payments/operator-guards.ts` :
```ts
import { BadRequestException } from '@nestjs/common';
import type { ProviderOperator } from './payment-provider.interface';

// V4 : le numéro (243 + 9 chiffres) doit appartenir à l'opérateur choisi. Évite
// un push voué à l'échec (et opaque pour l'utilisateur) vers le mauvais réseau.
export function assertPhoneMatchesOperator(
  op: ProviderOperator,
  phoneNumber: string,
): void {
  if (!op.phonePrefixes?.length) return; // préfixes inconnus : pas de contrôle
  const national = phoneNumber.startsWith('243')
    ? phoneNumber.slice(3)
    : phoneNumber;
  if (!op.phonePrefixes.some((p) => national.startsWith(p))) {
    throw new BadRequestException(
      "Ce numéro ne correspond pas à l'opérateur choisi.",
    );
  }
}
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `npx jest src/payments/operator-guards.spec.ts`
Expected: PASS.

- [ ] **Step 5: Migrer les specs vers les codes ARAKA et écrire les tests d'intégration qui échouent**

```bash
perl -pi -e "s/VODACOM_MPESA_COD/MPESA/g; s/'Vodacom M-Pesa'/'M-Pesa'/g" src/orders/Order.service.spec.ts src/payments/payouts.service.spec.ts
```

Dans `src/orders/Order.service.spec.ts`, le mock `getOperators` du `beforeEach` devient :
```ts
      getOperators: jest.fn().mockResolvedValue([
        { code: 'MPESA', name: 'M-Pesa', available: true, currencies: ['USD', 'CDF'], phonePrefixes: ['81', '82', '83'] },
      ]),
```
et ajouter (près des tests d'opérateur) :
```ts
  it('V4 : numéro d’un autre opérateur → 400, pas de réservation de stock ni initPayment', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);

    await expect(
      service.createOrder('user-1', dto(undefined, { phoneNumber: '243970000001' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.initPayment).not.toHaveBeenCalled();
  });
```

Dans `src/payments/payouts.service.spec.ts`, le mock `getOperators` du `beforeEach` devient :
```ts
      getOperators: jest.fn().mockResolvedValue([
        { code: 'MPESA', name: 'M-Pesa', available: true, currencies: ['CDF', 'USD'], payoutAvailable: true, phonePrefixes: ['81', '82', '83'] },
        { code: 'AFRIMONEY', name: 'Afrimoney', available: true, currencies: ['CDF', 'USD'], payoutAvailable: false, phonePrefixes: ['90', '91'] },
      ]),
```
et ajouter dans `describe('requestPayout'` :
```ts
    it('V8 : opérateur sans retrait (AFRIMONEY) → 400 avant OTP et solde', async () => {
      await expect(
        service.requestPayout('org-1', { currency: 'USD', amount: 50, phoneNumber: '243900000001', operator: 'AFRIMONEY' }),
      ).rejects.toThrow(BadRequestException);
      expect(otp.sendPayoutEmailOtp).not.toHaveBeenCalled();
      expect(earnings.getWithdrawable).not.toHaveBeenCalled();
    });

    it('V4 : numéro d’un autre opérateur → 400 avant OTP', async () => {
      await expect(
        service.requestPayout('org-1', { currency: 'USD', amount: 50, phoneNumber: '243970000001', operator: 'MPESA' }),
      ).rejects.toThrow(BadRequestException);
      expect(otp.sendPayoutEmailOtp).not.toHaveBeenCalled();
    });
```

- [ ] **Step 6: Lancer, vérifier l'échec**

Run: `npx jest src/orders/Order.service.spec.ts src/payments/payouts.service.spec.ts`
Expected: FAIL sur les 3 nouveaux tests (V4 achat, V8, V4 retrait) ; les autres PASS.

- [ ] **Step 7: Brancher les gardes**

`src/orders/Order.service.ts` : importer
```ts
import { assertPhoneMatchesOperator } from "src/payments/operator-guards";
```
et juste après le `if (!op || !op.available || !op.currencies.includes(currency)) { … }` :
```ts
        // V4 : le numéro doit appartenir au réseau de l'opérateur choisi.
        assertPhoneMatchesOperator(op, dto.phoneNumber);
```

`src/payments/payouts.service.ts` : importer
```ts
import { assertPhoneMatchesOperator } from './operator-guards';
```
et juste après la garde opérateur/devise de `requestPayout` :
```ts
    // V8 : opérateur acceptant les décaissements (ARAKA : pas AFRIMONEY) — refusé
    // AVANT l'OTP et le débit (sinon le retrait resterait bloqué en PENDING).
    if (op.payoutAvailable !== true) {
      throw new BadRequestException(
        'Cet opérateur ne permet pas les retraits. Choisissez-en un autre.',
      );
    }
    // V4 : le numéro doit appartenir au réseau de l'opérateur choisi.
    assertPhoneMatchesOperator(op, phoneNumber);
```

`src/orders/dto/CreateOrder.dto.ts` — remplacer le bloc push :
```ts
    // ─── Push Mobile Money ──────────────────────────────────────────────────────
    // Code opérateur du fournisseur (ex. MPESA). Fourni par le frontend depuis la
    // liste des opérateurs de GET /payments/config.
    @IsString()
    @Matches(/^[A-Z0-9_]+$/, { message: 'Opérateur Mobile Money invalide.' })
    operator : string;

    // Numéro Mobile Money RDC normalisé : indicatif 243 + 9 chiffres, sans « + »
    // (le front normalise ; le provider ajoute le « + » attendu par ARAKA).
    @IsString()
    @Matches(/^243\d{9}$/, { message: 'Numéro Mobile Money invalide.' })
    phoneNumber : string;
```

- [ ] **Step 8: Lancer, vérifier le succès**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/payments/operator-guards.ts src/payments/operator-guards.spec.ts src/orders/Order.service.ts src/orders/dto/CreateOrder.dto.ts src/payments/payouts.service.ts src/orders/Order.service.spec.ts src/payments/payouts.service.spec.ts
git commit -m "feat(paiement): V4 cohérence numéro/opérateur, V8 retrait refusé avant débit pour un opérateur sans décaissement"
```

---

### Task 8: V2 anti-harcèlement USSD, V3 plafond de checkouts en cours

**Files:**
- Create: `src/common/sliding-window-limiter.ts`
- Create: `src/common/sliding-window-limiter.spec.ts`
- Modify: `src/common/constants.ts`
- Modify: `src/orders/Order.service.ts`
- Modify: `src/orders/CreateOrder.controller.ts`
- Test: `src/orders/Order.service.spec.ts`

**Interfaces:**
- Produces: `class SlidingWindowLimiter { constructor(limit: number, windowMs: number, now?: () => number); tryHit(key: string): boolean }`.

- [ ] **Step 1: Écrire le test unitaire qui échoue**

`src/common/sliding-window-limiter.spec.ts` :
```ts
import { SlidingWindowLimiter } from './sliding-window-limiter';

describe('SlidingWindowLimiter', () => {
  it('autorise `limit` passages puis refuse dans la fenêtre', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(3, 1000, () => t);
    expect([1, 2, 3].map(() => limiter.tryHit('k'))).toEqual([true, true, true]);
    expect(limiter.tryHit('k')).toBe(false);
    t = 999;
    expect(limiter.tryHit('k')).toBe(false);
  });

  it('ré-autorise quand les passages sortent de la fenêtre', () => {
    let t = 0;
    const limiter = new SlidingWindowLimiter(1, 1000, () => t);
    expect(limiter.tryHit('k')).toBe(true);
    t = 1000;
    expect(limiter.tryHit('k')).toBe(true);
  });

  it('un refus ne consomme pas de passage ; les clés sont indépendantes', () => {
    const t = 0;
    const limiter = new SlidingWindowLimiter(1, 1000, () => t);
    expect(limiter.tryHit('a')).toBe(true);
    expect(limiter.tryHit('a')).toBe(false);
    expect(limiter.tryHit('b')).toBe(true);
  });
});
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx jest src/common/sliding-window-limiter.spec.ts`
Expected: FAIL — module introuvable.

- [ ] **Step 3: Implémenter le limiteur**

`src/common/sliding-window-limiter.ts` :
```ts
// Limiteur à fenêtre glissante EN MÉMOIRE : compteurs par instance, remis à zéro
// au redémarrage. Suffisant tant que le backend tourne sur une seule instance
// (Render). Au-delà : stockage partagé (Redis/Postgres).
const SWEEP_THRESHOLD = 10_000;

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  // true = autorisé (et comptabilisé) ; false = limite atteinte (rien n'est compté).
  tryHit(key: string): boolean {
    const t = this.now();
    if (this.hits.size > SWEEP_THRESHOLD) this.sweep(t);
    const recent = (this.hits.get(key) ?? []).filter((h) => t - h < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }

  // Borne la mémoire : retire les clés dont tous les passages sont périmés.
  private sweep(t: number): void {
    for (const [key, list] of this.hits) {
      if (list.every((h) => t - h >= this.windowMs)) this.hits.delete(key);
    }
  }
}
```

Run: `npx jest src/common/sliding-window-limiter.spec.ts`
Expected: PASS.

- [ ] **Step 4: Écrire les tests d'intégration qui échouent (`Order.service.spec.ts`)**

Dans le `beforeEach`, `prisma.order.findMany` par défaut renvoie une liste vide (aucun checkout en cours) :
```ts
        findMany: jest.fn().mockResolvedValue([]),
```

Ajouter :
```ts
  it('V3 : 2 checkouts déjà PENDING → 429, pas de réservation de stock', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);
    prisma.order.findMany.mockResolvedValue([{ paymentRef: 'VB1' }, { paymentRef: 'VB2' }]);

    const err = await service.createOrder('user-1', dto()).catch((e) => e);

    expect(err.getStatus()).toBe(429);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 'user-1', paymentStatus: 'PENDING' },
      distinct: ['paymentRef'],
    }));
  });

  it('V2 : 4ᵉ initiation vers le même numéro en 10 min → 429 (anti-harcèlement USSD)', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);

    // 3 utilisateurs différents visent le même numéro : la limite par numéro tranche.
    await service.createOrder('user-1', dto());
    await service.createOrder('user-2', dto());
    await service.createOrder('user-3', dto());
    const err = await service.createOrder('user-4', dto()).catch((e) => e);

    expect(err.getStatus()).toBe(429);
    expect(provider.initPayment).toHaveBeenCalledTimes(3);
  });

  it('V2 : 6ᵉ initiation d’un même utilisateur en 10 min → 429', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);
    const phones = ['243810000001', '243810000002', '243810000003', '243810000004', '243810000005', '243810000006'];

    for (const phoneNumber of phones.slice(0, 5)) {
      await service.createOrder('user-1', dto(undefined, { phoneNumber }));
    }
    const err = await service.createOrder('user-1', dto(undefined, { phoneNumber: phones[5] })).catch((e) => e);

    expect(err.getStatus()).toBe(429);
    expect(provider.initPayment).toHaveBeenCalledTimes(5);
  });
```

Run: `npx jest src/orders/Order.service.spec.ts`
Expected: FAIL sur les 3 nouveaux tests.

- [ ] **Step 5: Implémenter dans `OrderService`**

`src/common/constants.ts`, après `PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS` :
```ts
// V3 : checkouts PENDING simultanés max par utilisateur (anti-blocage de stock).
export const MAX_PENDING_CHECKOUTS_PER_USER = 2;
// V2 : initiations de paiement max par fenêtre (anti-harcèlement par push USSD).
export const CHECKOUT_LIMIT_WINDOW_MS = 10 * 60_000;
export const CHECKOUT_LIMIT_PER_PHONE = 3;
export const CHECKOUT_LIMIT_PER_USER = 5;
```

`src/orders/Order.service.ts` — imports :
```ts
import { HttpException, HttpStatus } from "@nestjs/common";
import { createHash } from "crypto";
import { SlidingWindowLimiter } from "src/common/sliding-window-limiter";
import { CHECKOUT_LIMIT_PER_PHONE, CHECKOUT_LIMIT_PER_USER, CHECKOUT_LIMIT_WINDOW_MS, MAX_PENDING_CHECKOUTS_PER_USER } from "src/common/constants";
```
(fusionner `HttpException, HttpStatus` dans l'import `@nestjs/common` existant).

Champs de classe, après `lastResolveAt` :
```ts
    // V2 : fenêtres glissantes en mémoire (par numéro haché + par utilisateur).
    private readonly phoneLimiter = new SlidingWindowLimiter(CHECKOUT_LIMIT_PER_PHONE, CHECKOUT_LIMIT_WINDOW_MS);
    private readonly userLimiter = new SlidingWindowLimiter(CHECKOUT_LIMIT_PER_USER, CHECKOUT_LIMIT_WINDOW_MS);
```

Juste après `assertPhoneMatchesOperator(op, dto.phoneNumber);` (Task 7), avant `const paymentRef = newTransactionRef();` :
```ts
        // V3 : plafond de checkouts en cours (sinon réservation de stock en rafale).
        const pending = await this.prisma.order.findMany({
            where: { userId, paymentStatus: 'PENDING' },
            select: { paymentRef: true },
            distinct: ['paymentRef'],
        });
        if (pending.length >= MAX_PENDING_CHECKOUTS_PER_USER) {
            throw new HttpException('Un paiement est déjà en cours. Validez-le sur votre téléphone ou attendez son expiration.', HttpStatus.TOO_MANY_REQUESTS);
        }

        // V2 : anti-harcèlement par push USSD (numéro jamais conservé en clair).
        const phoneKey = createHash('sha256').update(dto.phoneNumber).digest('hex');
        if (!this.userLimiter.tryHit(userId) || !this.phoneLimiter.tryHit(phoneKey)) {
            throw new HttpException('Trop de demandes de paiement. Réessayez dans quelques minutes.', HttpStatus.TOO_MANY_REQUESTS);
        }
```

- [ ] **Step 6: Limite par IP sur la route**

`src/orders/CreateOrder.controller.ts` : `import { Throttle } from "@nestjs/throttler";` puis, au-dessus de `@Post()` :
```ts
    // V2 : limite dédiée par IP (en plus des limites par utilisateur / numéro du service).
    @Throttle({ default: { ttl: 60_000, limit: 10 } })
```

- [ ] **Step 7: Lancer, vérifier le succès**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/common/sliding-window-limiter.ts src/common/sliding-window-limiter.spec.ts src/common/constants.ts src/orders/Order.service.ts src/orders/Order.service.spec.ts src/orders/CreateOrder.controller.ts
git commit -m "feat(paiement): V2 anti-harcèlement USSD (limites par numéro/utilisateur/IP), V3 max 2 checkouts en cours"
```

---

### Task 9: I1 — idempotence de `POST /order` (`Idempotency-Key`)

**Files:**
- Modify: `prisma/schema.prisma` (nouveau modèle `CheckoutRequest`)
- Create: `prisma/migrations/20260928120000_checkout_request_idempotency/migration.sql`
- Modify: `src/common/constants.ts`
- Modify: `src/orders/Order.service.ts` (`createOrder`)
- Modify: `src/orders/CreateOrder.controller.ts`
- Modify: `src/payments/payments.cleanup.ts` (purge)
- Test: `src/orders/Order.service.spec.ts`, `src/payments/payments.cleanup.spec.ts`

**Interfaces:**
- Consumes: `OrderService.getPaymentStatus(userId, paymentRef)` (existant), limites V2/V3 (Task 8).
- Produces: `OrderService.createOrder(userId: string, dto: CreateOrderDto, idempotencyKey?: string)` ; en-tête HTTP `Idempotency-Key` (UUID v4, optionnel) sur `POST /order`.

- [ ] **Step 1: Modèle Prisma**

`prisma/schema.prisma`, après le modèle `Order` :
```prisma
// Idempotence de POST /order (I1) : une clé client (en-tête Idempotency-Key) =
// un seul checkout. Rejouer la même clé renvoie le même paymentRef, sans nouvelle
// réservation de stock ni nouveau push. ARAKA ne déduplique pas les références :
// cette garantie est entièrement côté Vybe. Purgé après 24 h par le reaper.
model CheckoutRequest {
  id          String   @id @default(uuid())
  userId      String
  key         String
  // sha256 du panier trié + opérateur + numéro : une clé réutilisée pour un autre
  // panier est refusée (422).
  fingerprint String
  paymentRef  String
  createdAt   DateTime @default(now())

  @@unique([userId, key])
  @@index([createdAt]) // purge
}
```

- [ ] **Step 2: Migration écrite à la main (jamais `migrate dev` sur la base partagée)**

`prisma/migrations/20260928120000_checkout_request_idempotency/migration.sql` :
```sql
-- CreateTable
CREATE TABLE "CheckoutRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CheckoutRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CheckoutRequest_userId_key_key" ON "CheckoutRequest"("userId", "key");

-- CreateIndex
CREATE INDEX "CheckoutRequest_createdAt_idx" ON "CheckoutRequest"("createdAt");
```

Vérifier, **sans toucher à aucune base**, que ce SQL correspond exactement au schéma :

```bash
git show HEAD:prisma/schema.prisma > "$TMPDIR/schema-before.prisma"
```

```bash
npx prisma migrate diff --from-schema-datamodel "$TMPDIR/schema-before.prisma" --to-schema-datamodel prisma/schema.prisma --script
```
Expected: le même `CREATE TABLE` + les deux `CREATE INDEX` que `migration.sql`.

Puis régénérer le client (aucun accès base) :

Run: `npx prisma generate`
Expected: « Generated Prisma Client ».

La migration sera appliquée par `prisma migrate deploy` au build Render (Task 13). En local, tant qu'elle n'est pas appliquée, un `POST /order` **avec** clé échouera — les tests unitaires, eux, n'utilisent pas la base.

- [ ] **Step 3: Écrire les tests qui échouent (`Order.service.spec.ts`)**

Types des mocks : ajouter `checkoutRequest: { findUnique: jest.Mock };` au type de `prisma`, et `checkoutRequest: { create: jest.Mock };` au type de `tx`. Dans le `beforeEach` :
```ts
    // dans tx :
      checkoutRequest: { create: jest.fn().mockResolvedValue({}) },
    // dans prisma :
      checkoutRequest: { findUnique: jest.fn().mockResolvedValue(null) },
```

Import à ajouter : `UnprocessableEntityException` (depuis `@nestjs/common`) et `import { Prisma } from '@prisma/client';`.

Tests :
```ts
  describe('I1 : idempotence (Idempotency-Key)', () => {
    const KEY = '4f1c6a8e-2b7d-4c3a-9e5f-1a2b3c4d5e6f';
    const p2002 = () =>
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
      });
    const pendingOrder = (paymentRef: string) => ({
      id: 'order-1', paymentRef, paymentStatus: 'PENDING', currency: 'USD', chargedAmount: 200,
    });

    it('nouvelle clé → CheckoutRequest créée DANS la transaction du checkout', async () => {
      prisma.ticketCategory.findMany.mockResolvedValue([category()]);

      await service.createOrder('user-1', dto(), KEY);

      const ref = tx.order.create.mock.calls[0][0].data.paymentRef;
      expect(tx.checkoutRequest.create).toHaveBeenCalledWith({
        data: { userId: 'user-1', key: KEY, fingerprint: expect.any(String), paymentRef: ref },
      });
    });

    it('même clé + même panier → même paymentRef, aucune réservation ni initPayment de plus', async () => {
      prisma.ticketCategory.findMany.mockResolvedValue([category()]);
      await service.createOrder('user-1', dto(), KEY);
      const { fingerprint, paymentRef } = tx.checkoutRequest.create.mock.calls[0][0].data;

      prisma.checkoutRequest.findUnique.mockResolvedValue({ paymentRef, fingerprint });
      prisma.order.findMany.mockResolvedValue([pendingOrder(paymentRef)]);
      const res = await service.createOrder('user-1', dto(), KEY);

      expect(res.paymentRef).toBe(paymentRef);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(provider.initPayment).toHaveBeenCalledTimes(1);
    });

    it('même clé + autre panier → 422', async () => {
      prisma.ticketCategory.findMany.mockResolvedValue([category()]);
      prisma.checkoutRequest.findUnique.mockResolvedValue({ paymentRef: 'VBX', fingerprint: 'autre-panier' });

      await expect(service.createOrder('user-1', dto(), KEY)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('clé mal formée → 400', async () => {
      prisma.ticketCategory.findMany.mockResolvedValue([category()]);
      await expect(service.createOrder('user-1', dto(), 'pas-un-uuid')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('course sur la même clé (P2002) → renvoie le checkout gagnant, sans initPayment', async () => {
      prisma.ticketCategory.findMany.mockResolvedValue([category()]);
      let fingerprint = '';
      tx.checkoutRequest.create.mockImplementation(({ data }: any) => {
        fingerprint = data.fingerprint;
        return Promise.reject(p2002());
      });
      prisma.checkoutRequest.findUnique
        .mockResolvedValueOnce(null) // 1er contrôle : clé encore inconnue
        .mockImplementationOnce(() => Promise.resolve({ paymentRef: 'VBGAGNANT', fingerprint }));
      prisma.order.findMany.mockResolvedValue([pendingOrder('VBGAGNANT')]);

      const res = await service.createOrder('user-1', dto(), KEY);

      expect(res.paymentRef).toBe('VBGAGNANT');
      expect(provider.initPayment).not.toHaveBeenCalled();
    });

    it('sans clé → comportement inchangé (aucune CheckoutRequest)', async () => {
      prisma.ticketCategory.findMany.mockResolvedValue([category()]);
      await service.createOrder('user-1', dto());
      expect(tx.checkoutRequest.create).not.toHaveBeenCalled();
      expect(prisma.checkoutRequest.findUnique).not.toHaveBeenCalled();
    });
  });
```

`src/payments/payments.cleanup.spec.ts` : type `prisma` → `{ order: { findMany: jest.Mock }; checkoutRequest: { deleteMany: jest.Mock } }`, et dans le `beforeEach` :
```ts
    prisma = {
      order: { findMany: jest.fn().mockResolvedValue([]) },
      checkoutRequest: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
```
puis :
```ts
  it('I1 : purge les clés d’idempotence de plus de 24 h', async () => {
    await service.reapExpiredPayments();
    const where = prisma.checkoutRequest.deleteMany.mock.calls[0][0].where;
    expect(where.createdAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 24 * 3_600_000);
  });
```

- [ ] **Step 4: Lancer, vérifier l'échec**

Run: `npx jest src/orders/Order.service.spec.ts src/payments/payments.cleanup.spec.ts`
Expected: FAIL sur les tests I1 (paramètre ignoré, aucune `CheckoutRequest`, pas de purge).

- [ ] **Step 5: Implémenter dans `OrderService`**

`src/common/constants.ts`, après les constantes V2/V3 :
```ts
// I1 : durée de conservation des clés d'idempotence de POST /order.
export const CHECKOUT_REQUEST_RETENTION_HOURS = 24;
```

`src/orders/Order.service.ts` — imports : ajouter `UnprocessableEntityException` à l'import `@nestjs/common`, puis
```ts
import { Prisma } from "@prisma/client";
import { isUUID } from "class-validator";
```

Au-dessus de la classe (après `STATUS_RESOLVE_THROTTLE_MS`) :
```ts
// I1 : empreinte d'un panier. Une clé d'idempotence ne sert qu'à CE panier
// (mêmes lignes, même opérateur, même numéro), indépendamment de l'ordre des lignes.
function checkoutFingerprint(dto: CreateOrderDto): string {
    const items = [...dto.items]
        .sort((a, b) => a.ticketCategoryId.localeCompare(b.ticketCategoryId))
        .map((i) => [i.ticketCategoryId, i.quantity]);
    return createHash('sha256')
        .update(JSON.stringify({ items, operator: dto.operator, phoneNumber: dto.phoneNumber }))
        .digest('hex');
}
```

Signature et début de `createOrder` :
```ts
    async createOrder(userId: string, dto: CreateOrderDto, idempotencyKey?: string){
        // I1 : idempotence (double clic / renvoi réseau). Même clé + même panier =
        // même checkout, renvoyé tel quel (ni stock, ni V2/V3, ni nouveau push).
        let fingerprint: string | undefined;
        if (idempotencyKey !== undefined) {
            if (!isUUID(idempotencyKey, 4)) {
                throw new BadRequestException('En-tête Idempotency-Key invalide (UUID attendu).');
            }
            fingerprint = checkoutFingerprint(dto);
            const replay = await this.replayCheckout(userId, idempotencyKey, fingerprint);
            if (replay) return replay;
        }

        const items = dto.items;
```

Dans la transaction de réservation, **en premier** (avant la boucle `for (const line of lines)`) :
```ts
                // I1 : la clé est réclamée DANS la transaction du checkout. Une requête
                // concurrente avec la même clé échoue ici (P2002) après notre commit.
                if (idempotencyKey !== undefined) {
                    await tx.checkoutRequest.create({
                        data: { userId, key: idempotencyKey, fingerprint: fingerprint!, paymentRef },
                    });
                }
```

Entourer ce `await this.prisma.$transaction(async (tx) => { … });` de réservation par :
```ts
        try {
            await this.prisma.$transaction(async (tx) => {
                // … (contenu existant + claim ci-dessus)
            });
        } catch (err) {
            if (
                idempotencyKey !== undefined &&
                err instanceof Prisma.PrismaClientKnownRequestError &&
                err.code === 'P2002'
            ) {
                // Course sur la même clé : l'autre requête a gagné ; notre transaction
                // est annulée (stock rendu). On renvoie SON checkout.
                const replay = await this.replayCheckout(userId, idempotencyKey, fingerprint!);
                if (replay) return replay;
            }
            throw err;
        }
```

Méthode privée (après `loadCheckoutOrders`) :
```ts
    // I1 : état du checkout déjà créé avec cette clé ; null si la clé est inconnue.
    // Clé connue mais panier différent → 422 (jamais deux paniers sous une clé).
    private async replayCheckout(userId: string, key: string, fingerprint: string) {
        const existing = await this.prisma.checkoutRequest.findUnique({
            where: { userId_key: { userId, key } },
        });
        if (!existing) return null;
        if (existing.fingerprint !== fingerprint) {
            throw new UnprocessableEntityException("Clé d'idempotence déjà utilisée pour une autre commande.");
        }
        return this.getPaymentStatus(userId, existing.paymentRef);
    }
```

- [ ] **Step 6: Contrôleur**

`src/orders/CreateOrder.controller.ts` : ajouter `Headers` à l'import `@nestjs/common`, et :
```ts
    @Post()
    async create(
        @Req() req,
        @Body() dto: CreateOrderDto,
        // I1 : optionnelle (compatibilité le temps de déployer le front).
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.ordersService.createOrder(req.user.sub, dto, idempotencyKey)
    }
```

- [ ] **Step 7: Purge dans le reaper**

`src/payments/payments.cleanup.ts` : importer `CHECKOUT_REQUEST_RETENTION_HOURS` depuis `src/common/constants`, et au tout début de `reapExpiredPayments()` :
```ts
    // I1 : purge des clés d'idempotence périmées (un rejeu au-delà n'a plus de sens).
    try {
      await this.prisma.checkoutRequest.deleteMany({
        where: {
          createdAt: {
            lt: new Date(Date.now() - CHECKOUT_REQUEST_RETENTION_HOURS * 3_600_000),
          },
        },
      });
    } catch (err) {
      this.logger.warn(`Purge CheckoutRequest impossible : ${String(err)}`);
    }
```

- [ ] **Step 8: Lancer, vérifier le succès**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20260928120000_checkout_request_idempotency src/common/constants.ts src/orders/Order.service.ts src/orders/Order.service.spec.ts src/orders/CreateOrder.controller.ts src/payments/payments.cleanup.ts src/payments/payments.cleanup.spec.ts
git commit -m "feat(paiement): I1 — idempotence de POST /order (Idempotency-Key, table CheckoutRequest)"
```

---

### Task 10: I2 — validation de retrait à usage unique (`jti` + `UsedToken`)

**Files:**
- Modify: `src/payments/payouts.service.ts` (`requestPayout`, `verifyPayout`)
- Test: `src/payments/payouts.service.spec.ts`

**Interfaces:**
- Consumes: table `UsedToken` (existante, `jti` clé primaire).
- Produces: `tempToken` de retrait portant `jti` ; `verifyPayout` → `409 ConflictException` si déjà validé.

- [ ] **Step 1: Écrire les tests qui échouent**

`src/payments/payouts.service.spec.ts` : `import { Prisma } from '@prisma/client';` et ajouter `ConflictException` à l'import `@nestjs/common`. Dans le `beforeEach` : ajouter au mock `prisma`
```ts
      usedToken: { create: jest.fn().mockResolvedValue({}) },
```
et `jti: 'jti-1'` au payload renvoyé par `jwt.verify`.

Dans `describe('requestPayout'` :
```ts
    it('I2 : le tempToken porte un jti unique', async () => {
      await service.requestPayout('org-1', {
        currency: 'USD', amount: 50, phoneNumber: '243812345678', operator: 'MPESA',
      });
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ jti: expect.any(String) }),
        expect.anything(),
      );
    });
```

Dans le `describe` de `verifyPayout` (celui qui contient « débite le ledger ») :
```ts
    it('I2 : consomme le jti dans la transaction du débit', async () => {
      await service.verifyPayout('org-1', '123456', 'temp.jwt');
      expect(prisma.usedToken.create).toHaveBeenCalledWith({ data: { jti: 'jti-1' } });
    });

    it('I2 : jti déjà consommé (double soumission) → 409, aucun débit ni initPayout', async () => {
      prisma.usedToken.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );
      await expect(service.verifyPayout('org-1', '123456', 'temp.jwt')).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(prisma.payout.create).not.toHaveBeenCalled();
      expect(provider.initPayout).not.toHaveBeenCalled();
    });

    it('I2 : token sans jti → 401, aucun mouvement', async () => {
      jwt.verify.mockReturnValue({
        sub: 'org-1', type: 'payout', currency: 'USD', amount: 50, phoneNumber: '243812345678', operator: 'MPESA',
      });
      await expect(service.verifyPayout('org-1', '123456', 'temp.jwt')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    });
```

- [ ] **Step 2: Lancer, vérifier l'échec**

Run: `npx jest src/payments/payouts.service.spec.ts`
Expected: FAIL sur les 4 tests I2.

- [ ] **Step 3: Implémenter**

`src/payments/payouts.service.ts` — imports : ajouter `ConflictException` à l'import `@nestjs/common` ; `import { randomUUID } from 'crypto';` ; `import { $Enums, Prisma } from '@prisma/client';` (remplace l'import de `$Enums` seul).

Dans `requestPayout`, le payload signé gagne un `jti` :
```ts
    const tempToken = this.jwt.sign(
      {
        sub: userId,
        type: 'payout',
        // I2 : identifiant unique, consommé une seule fois à la validation.
        jti: randomUUID(),
        currency,
        amount,
        phoneNumber,
        operator: dto.operator,
      },
      { expiresIn: '10m' },
    );
```

Dans `verifyPayout` : ajouter `jti?: string;` au type de `payload`, puis après les deux contrôles `type` / `sub` :
```ts
    // I2 : un tempToken de retrait est à usage unique (jti consommé ci-dessous).
    if (!payload.jti) throw new UnauthorizedException('Token invalide ou expiré.');
    const jti = payload.jti;
```

Dans la transaction de débit, juste **après** `pg_advisory_xact_lock` :
```ts
      // I2 : consommation du jti DANS la transaction du débit. Une seconde
      // validation concurrente échoue ici (P2002) → rollback, aucun débit.
      await tx.usedToken.create({ data: { jti } });
```

Entourer ce `const payout = await this.prisma.$transaction(…)` par :
```ts
    // Seul payout.id est utilisé après la transaction.
    let payout: { id: string };
    try {
      payout = await this.prisma.$transaction(async (tx) => {
        // … (contenu existant + consommation du jti ci-dessus)
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('Ce retrait a déjà été validé.');
      }
      throw err;
    }
```

- [ ] **Step 4: Lancer, vérifier le succès**

Run: `npx jest src/payments/payouts.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/payments/payouts.service.ts src/payments/payouts.service.spec.ts
git commit -m "fix(paiement): I2 — validation de retrait à usage unique (jti consommé dans la transaction du débit)"
```

---

### Task 11: Nettoyage des mentions PawaPay, documentation, vérification finale

**Files:**
- Modify: commentaires de `src/common/constants.ts`, `src/common/money.ts`, `src/orders/Order.service.ts`, `src/payments/earnings.service.ts`, `src/payments/payment-provider.interface.ts`, `src/payments/payments.controller.ts`, `src/payments/payments.service.ts`, `src/payments/payouts.service.ts`
- Modify: `CLAUDE.md` (section Config)

- [ ] **Step 1: Lister les mentions restantes**

Run: `grep -rn "pawapay\|PAWAPAY\|PawaPay\|VODACOM\|RFC-9421\|depositId" src CLAUDE.md`

- [ ] **Step 2: Réécrire chaque mention**

Règle : un commentaire qui décrit un comportement **générique** remplace « PawaPay » par « le fournisseur » ; un commentaire qui décrit ARAKA le nomme ; les exemples d'opérateur deviennent `MPESA`. Cas particuliers :
- `payment-provider.interface.ts` : `WebhookRequestContext` reste (contrat) — son commentaire devient « Contexte de la requête HTTP entrante, pour un fournisseur dont la signature couvre des composants dérivés (@method/@path/@authority). ARAKA signe seulement le corps et l'ignore. » ; le commentaire de `verifyWebhookSignature` perd la mention « requis en prod PawaPay » ; l'exemple d'opérateur devient `MPESA`.
- `payments.controller.ts` : « c'est le fournisseur (ARAKA) qui appelle » ; « la signature HMAC porte sur les octets exacts reçus » ; le commentaire du contexte RFC-9421 devient « Contexte requête transmis au provider (utile aux fournisseurs qui signent @method/@path/@authority ; ARAKA l'ignore). »
- `Order.service.ts` : « pour ne pas marteler le fournisseur à chaque poll ».

Run: `grep -rn "pawapay\|PAWAPAY\|PawaPay\|VODACOM" src`
Expected: aucune sortie.

- [ ] **Step 3: `CLAUDE.md`**

Remplacer, dans la section Config, la phrase sur les identifiants PawaPay par :
```markdown
Fournisseur Mobile Money : **ARAKA (ProxyPay)**, `src/payments/araka.provider.ts`. Variables : `ARAKA_BASE_URL` (https obligatoire ; UAT `https://araka-api-uat.azurewebsites.net/api`), `ARAKA_EMAIL` / `ARAKA_PASSWORD` (login → JWT 2 h mis en cache), `ARAKA_PAYMENT_PAGE_ID` (une seule page pour USD et CDF), `ARAKA_CALLBACK_KEY` (HMAC-SHA256 base64 du callback, fournie par ProxyPay ; absente → webhook 401, résolution par polling/reaper), `ARAKA_DISABLED_OPERATORS` (optionnelle, ex. `ORANGE` : grise un opérateur en panne). Spec : `docs/superpowers/specs/2026-09-27-araka-provider-design.md`.
```

- [ ] **Step 4: Vérification finale**

Run: `npm run test`
Expected: toutes les suites PASS.

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: aucune erreur.

Run: `npx eslint src/payments src/orders src/common`
Expected: aucune **erreur** (warnings tolérés selon `eslint.config.mjs`).

- [ ] **Step 5: Commit**

```bash
git add -A src CLAUDE.md
git commit -m "chore(paiement): retire les mentions PawaPay, documente la configuration ARAKA"
```

---

### Task 12: Front — clé d'idempotence, retrait filtré, contrôle du préfixe (repo `vybeFrontend`)

**Files (dans `/Users/user/vybeFrontend`):**
- Modify: `src/types/api.ts` (`PaymentOperator`)
- Modify: `src/lib/payments.ts` + Test: `src/lib/payments.test.ts`
- Modify: `src/components/vybe/Buy.tsx` (`submit`)
- Modify: `src/components/vybe/WithdrawSheet.tsx` (filtre + `submitForm`)
- Modify: `src/components/vybe/Buy.test.tsx`, `src/components/vybe/Wallet.test.tsx` (codes opérateurs de test)

**Interfaces:**
- Consumes: `GET /payments/config` → opérateurs avec `payoutAvailable?: boolean`, `phonePrefixes?: string[]`.
- Produces: `phoneMatchesOperator(normalized: string, op: PaymentOperator): boolean`.

- [ ] **Step 1: Branche (jamais depuis `main`)**

Branche déjà créée : `front-araka-provider`, issue de `feat/event-details-tablet-responsive` (qui contient `feat/checkout-payment` et `main`). Se placer dessus :

```bash
git -C /Users/user/vybeFrontend switch front-araka-provider
```

- [ ] **Step 1b: I1 — envoyer une clé d'idempotence avec `POST /order`**

`src/types/api.ts`, après `CreateOrderPayload` (et corriger son commentaire d'opérateur : `// code opérateur (ex. 'MPESA')`) :
```ts
/** Variables de la mutation d'achat : payload + clé d'idempotence (en-tête). */
export type CreateOrderRequest = CreateOrderPayload & { idempotencyKey?: string };
```

`src/services/tickets.service.ts` :
```ts
  createOrder(
    payload: CreateOrderPayload,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<CreateOrderResponse> {
    return api.post<CreateOrderResponse>("/order", payload, {
      signal,
      headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
    });
  },
```

Test (dans `src/services/tickets.service.test.ts`, bloc `createOrder / getOrderStatus`) :
```ts
  it("createOrder transmet la clé d'idempotence en en-tête", async () => {
    vi.mocked(api.post).mockResolvedValue({ paymentRef: "VB1" } as never);
    const payload = { items: [{ ticketCategoryId: "c1", quantity: 1 }], operator: "MPESA", phoneNumber: "243810000001" };
    await ticketsService.createOrder(payload, undefined, "4f1c6a8e-2b7d-4c3a-9e5f-1a2b3c4d5e6f");
    expect(api.post).toHaveBeenCalledWith("/order", payload, {
      signal: undefined,
      headers: { "Idempotency-Key": "4f1c6a8e-2b7d-4c3a-9e5f-1a2b3c4d5e6f" },
    });
  });
```

`src/hooks/queries/use-tickets.ts`, dans `useCreateOrder` :
```ts
  return useMutation<CreateOrderResponse, ApiError, CreateOrderRequest>({
    mutationFn: ({ idempotencyKey, ...payload }) =>
      ticketsService.createOrder(payload, undefined, idempotencyKey),
```
(importer `CreateOrderRequest`).

`src/components/vybe/Buy.tsx` — état de la clé, à côté des autres `useState` :
```tsx
  // I1 : clé d'idempotence du checkout. Conservée pour un renvoi (échec réseau /
  // 5xx) ; régénérée dès que le panier, l'opérateur ou le numéro change, ou après
  // un 4xx (une correction = une nouvelle commande).
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  useEffect(() => {
    setIdempotencyKey(crypto.randomUUID());
  }, [qty, operator, phone]);
```
dans `submit`, ajouter `idempotencyKey` à l'objet passé à `createOrder.mutateAsync({ … })`, et dans le `catch` :
```tsx
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        setIdempotencyKey(crypto.randomUUID());
      }
```

Run: `npx vitest run src/services/tickets.service.test.ts` (dans `/Users/user/vybeFrontend`)
Expected: PASS.

- [ ] **Step 2: Type**

`src/types/api.ts`, dans `PaymentOperator`, après `currencies` :
```ts
  /** Retraits possibles vers cet opérateur (ARAKA : pas Afrimoney). */
  payoutAvailable?: boolean;
  /** Préfixes nationaux (après 243) des numéros de cet opérateur. */
  phonePrefixes?: string[];
```

- [ ] **Step 3: Test qui échoue**

`src/lib/payments.test.ts` — ajouter `phoneMatchesOperator` à l'import de `@/lib/payments` et `import type { PaymentOperator } from "@/types/api";`, puis :
```ts
describe("phoneMatchesOperator", () => {
  const mpesa: PaymentOperator = {
    code: "MPESA",
    name: "M-Pesa",
    available: true,
    currencies: ["USD", "CDF"],
    phonePrefixes: ["81", "82", "83"],
  };
  it("numéro du bon réseau → true", () => {
    expect(phoneMatchesOperator("243810000001", mpesa)).toBe(true);
  });
  it("numéro d'un autre réseau → false", () => {
    expect(phoneMatchesOperator("243970000001", mpesa)).toBe(false);
  });
  it("préfixes inconnus → true (le backend tranche)", () => {
    expect(phoneMatchesOperator("243970000001", { ...mpesa, phonePrefixes: undefined })).toBe(true);
  });
});
```

Run: `npx vitest run src/lib/payments.test.ts` (dans `/Users/user/vybeFrontend`)
Expected: FAIL — `phoneMatchesOperator` n'existe pas.

- [ ] **Step 4: Implémenter**

`src/lib/payments.ts`, après `normalizeMobileNumber` :
```ts
/**
 * Le numéro normalisé (243XXXXXXXXX) appartient-il au réseau de l'opérateur ?
 * Sans préfixes connus, on laisse le backend trancher.
 */
export function phoneMatchesOperator(normalized: string, op: PaymentOperator): boolean {
  if (!op.phonePrefixes?.length) return true;
  const national = normalized.startsWith("243") ? normalized.slice(3) : normalized;
  return op.phonePrefixes.some((p) => national.startsWith(p));
}
```
(ajouter `import type { PaymentOperator } from "@/types/api";` si absent).

Run: `npx vitest run src/lib/payments.test.ts`
Expected: PASS.

- [ ] **Step 5: Brancher dans l'achat et le retrait**

`src/components/vybe/Buy.tsx`, dans `submit`, juste après `if (!normalized) return setSubmitError("Numéro Mobile Money invalide.");` :
```tsx
    const opConfig = (config.data?.operators ?? []).find((o) => o.code === operator);
    if (opConfig && !phoneMatchesOperator(normalized, opConfig)) {
      return setSubmitError(`Ce numéro n'est pas un numéro ${opConfig.name}.`);
    }
```
(adapter `config` au nom de la variable `usePaymentConfig()` du composant ; importer `phoneMatchesOperator` depuis `@/lib/payments`).

`src/components/vybe/WithdrawSheet.tsx` — filtre :
```tsx
  // Opérateurs acceptant les retraits dans la devise choisie.
  const operators = (config.data?.operators ?? []).filter(
    (o) => o.available && o.payoutAvailable !== false && o.currencies.includes(currency),
  );
```
et dans `submitForm`, après la vérification `if (!operator)` :
```tsx
    const opConfig = operators.find((o) => o.code === operator);
    if (opConfig && !phoneMatchesOperator(normalized, opConfig)) {
      setErr(`Ce numéro n'est pas un numéro ${opConfig.name}.`);
      return;
    }
```

- [ ] **Step 6: Codes opérateurs des tests**

```bash
perl -pi -e 's/VODACOM_MPESA_COD/MPESA/g' src/components/vybe/Buy.test.tsx src/components/vybe/Wallet.test.tsx
```

Run: `npm run test` (dans `/Users/user/vybeFrontend`)
Expected: PASS. Les erreurs 429 (V2/V3) s'affichent déjà : `ApiError.userMessage` renvoie le message du backend pour un 4xx.

- [ ] **Step 7: Commit**

```bash
git -C /Users/user/vybeFrontend add -A src
git -C /Users/user/vybeFrontend commit -m "feat(paiement): opérateurs ARAKA — retrait filtré (payoutAvailable), contrôle numéro ↔ opérateur"
```

---

### Task 13: Vérification sur staging Render (manuel)

Pas de tunnel local : on vérifie comme d'habitude, sur le staging Render (webhook public `https://vybe-staging.onrender.com/payments/webhook`), une fois backend **et** front déployés ensemble.

- [ ] **Step 1: Variables d'environnement du service staging (Render)**

Retirer `PAWAPAY_BASE_URL`, `PAWAPAY_API_TOKEN`, `PAWAPAY_PUBLIC_KEY` ; ajouter :
```
ARAKA_BASE_URL=https://araka-api-uat.azurewebsites.net/api
ARAKA_EMAIL=<e-mail marchand>
ARAKA_PASSWORD=<mot de passe>
ARAKA_PAYMENT_PAGE_ID=2144EA75-1B78-461B-84AF-1EE1D8A0BF92
```
(`ARAKA_CALLBACK_KEY` dès que ProxyPay l'a fournie ; sans elle, webhook 401 et résolution par polling/reaper — attendu.)

- [ ] **Step 2: Déploiement**

Déployer la branche backend puis le front. La migration `CheckoutRequest` (Task 9) est appliquée par le `prisma migrate deploy` du build Render.

- [ ] **Step 3: Parcours**

1. `GET /payments/config` → 4 opérateurs ARAKA ; `AFRIMONEY` absent du sélecteur de retrait.
2. Achat `MPESA` / `0810000001` (succès) → écran « validez sur votre téléphone » → `PAID` + billets.
3. Achat `0810000003` (échec) → `FAILED`, stock relâché.
4. Achat `MPESA` / `0970000001` → message « Ce numéro n'est pas un numéro M-Pesa » (V4, côté front).
5. Double clic rapide sur « Payer » → un seul checkout, un seul `paymentRef` (I1).
6. Retrait `MPESA` `0810000001` → `PENDING` puis `COMPLETED` au passage du reaper (≤ 10 min) ; double validation de l'OTP → débité une seule fois (I2).
7. Logs Render : callback ARAKA reçu sur `/payments/webhook` ; `PaymentProviderLog` contient `originatingTransactionId` = notre `paymentRef`.
