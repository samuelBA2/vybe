# Remplacement de PawaPay par ARAKA (ProxyPay) — Design

Date : 2026-09-27
Repo : backend `/Users/user/vybe` (NestJS + Prisma + Postgres/Neon)
Prolonge : `2026-09-09-paiement-design.md` (interface `PaymentProvider` agnostique du fournisseur).
Sources : manuel « ARAKA Payment Integration Manual v2.7 » (e-commerce), manuel « ARAKA API for VAS
Integration » (payout `sendmobilemoney`), essais réels sur le sandbox UAT (2026-09-26/27).

## Objectif

Remplacer PawaPay par l'agrégateur ARAKA (ProxyPay) pour l'encaissement (achat de billets) **et** le
décaissement (retrait organisateur), en conservant **exactement** le fonctionnement actuel :
push Mobile Money (validation USSD/PIN sur le téléphone de l'acheteur), callback + re-vérification
serveur (source de vérité), polling front, reaper, comptabilité, idempotence.

**Décisions prises :**
- **Remplacement complet** : PawaPay est supprimé (reste dans l'historique git). Pas de coexistence.
- **Approche « provider propre »** : un `ArakaProvider` implémente `PaymentProvider` ; le contrat
  gagne l'extraction de référence du callback, de sorte que les services ne connaissent plus aucun
  format de fournisseur.
- **Aucune rupture du contrat front** (`POST /order`, `GET /payments/config`, `/me/payouts`).

## Faits établis en sandbox (UAT)

| Constat | Conséquence |
|---|---|
| `POST /api/login` → JWT valable **2 h** (claim `exp` présent) | cache du token + re-login |
| `paymentrequest` répond `ACCEPTED` ; le statut final arrive **en différé** | `ACCEPTED` ≠ payé |
| `transactionstatusbyreference/{ref}` rejoint le portail (DECLINED/APPROVED) après délai | source de vérité fiable |
| Réponse de `byreference` = **tableau** de transactions | agrégation des éléments |
| Araka **n'impose pas l'unicité** de `transactionReference` (réutilisation → plusieurs transactions) | unicité garantie côté Vybe |
| Élément de statut : `transactionId` (id Araka, numérique), `status`, `transactionReference`, `originatingTransactionId` (= **notre** référence) | champs de lecture |
| Référence inconnue sur `transactionstatus/{id}` → **HTTP 500** (pas 404) | 500 = inconnu, jamais DECLINED |
| Aucun montant observé dans la réponse de statut | contrôle anti-divergence de montant non applicable |
| Une Payment Page créée en **USD** accepte un paiement **CDF** : 2 500 CDF affichés tels quels au portail (VBTEST0020) | **une seule** `ARAKA_PAYMENT_PAGE_ID` pour les deux devises |

Base URL UAT : `https://araka-api-uat.azurewebsites.net/api` (les chemins ci-dessous sont relatifs à
`/api`).

## Composants

### `src/payments/araka.provider.ts` (nouveau) — implémente `PaymentProvider`

| Méthode | Appel ARAKA | Traduction |
|---|---|---|
| *(privé)* `getToken()` | `POST /login` `{ emailAddress, password }` | Token gardé en mémoire jusqu'à `exp` − 60 s (décodage du payload JWT, sans vérification de signature ; à défaut TTL 1 h 50). Sur **401** d'un appel : un seul re-login + nouvel essai, puis exception. |
| `initPayment` | `POST /pay/paymentrequest`, header `X-API-CALLBACK-MODE: 2` | Body : `order{ paymentPageId: ARAKA_PAYMENT_PAGE_ID, transactionReference: paymentRef, amount, currency, redirectURL }`, `paymentChannel{ channel: 'MOBILEMONEY', provider: operator, walletID: '+' + phoneNumber }`. Réponse `statusCode` `202`/`ACCEPTED` → `{ paymentRef, providerTxnId: transactionId }`. Tout autre code → exception (déclenche la compensation existante de `OrderService`). |
| `checkStatus` | `GET /reporting/transactionstatusbyreference/{paymentRef}` | Voir « Règles de statut ». |
| `verifyWebhookSignature` | — | HMAC-SHA256 (clé `ARAKA_CALLBACK_KEY` en UTF-8) sur le **corps brut** UTF-8 ; comparaison en temps constant avec `X-APP-SIGNATURE` décodé en **Base64** (exemple C# `VerifyCallback` du manuel). Clé absente, header absent, longueur différente → `false` (fail-closed). |
| `extractPaymentRef` | — | `JSON.parse(rawBody).originatingTransactionId` ; illisible/absent → `undefined`. |
| `extractPayoutRef` | — | Même champ (`originatingTransactionId`). Aucun callback payout n'est documenté : méthode présente pour le contrat. |
| `getOperators` | — (aucun endpoint) | Liste fixe : `MPESA`, `ORANGE`, `AIRTEL`, `AFRIMONEY`, chacun `available: true`, `currencies: ['USD','CDF']`. |
| `initPayout` | `POST /pay/sendmobilemoney` | Body : `order{ transactionReference: payoutRef, amount, currency }`, `destination{ provider: operator, walletID: '+' + phoneNumber }`. Opérateur `AFRIMONEY` (non supporté en payout) → exception **avant** tout appel réseau. Voir « Règles de statut ». |
| `checkPayoutStatus` | `GET /reporting/transactionstatusbyreference/{payoutRef}` | Mêmes règles que `checkStatus` (à confirmer par ProxyPay). |

Tous les appels : `fetch` avec timeout explicite de **15 s** (`AbortSignal.timeout`). Aucun log ne
contient token, mot de passe ni numéro complet (numéro masqué `+243******01`).

### Contrat `PaymentProvider` (`payment-provider.interface.ts`) — ajouts

- `extractPaymentRef(rawBody: string): string | undefined`
- `extractPayoutRef(rawBody: string): string | undefined`
- `InitPaymentResult.providerTxnId?: string` — id fournisseur, stocké dans `Order.providerTxnId`
  (aujourd'hui on y recopie `initResult.paymentRef`, qui est notre propre référence).
- `CheckStatusResult.approvedCount?: number` — nombre de transactions `APPROVED` sous la référence
  (détection de double débit).
- Commentaires mis à jour : suppression des mentions PawaPay (RFC-9421, `VODACOM_MPESA_COD`,
  `depositId`), exemples remplacés par les codes ARAKA.

### Références de transaction — `src/common/transaction-ref.ts` (nouveau)

`newTransactionRef(): string` → `'VB'` + 18 caractères base32 (alphabet `A-Z2-7`) issus de
`crypto.randomBytes` : **20 caractères** (limite ARAKA `String(20)`), ≈ 90 bits d'entropie.
Remplace `randomUUID()` pour `paymentRef` (`src/orders/Order.service.ts`) et `payoutRef`
(`src/payments/payouts.service.ts`). **Aucune migration** : colonnes déjà `String`. Les anciennes
références UUID restent lisibles. Comme ARAKA ne déduplique pas, l'unicité repose sur ce générateur
et sur le fait qu'on ne ré-initie **jamais** un paiement avec une référence existante.

### Services — ajustements

- `PaymentsService.handleWebhook` : `paymentRef = this.payment.extractPaymentRef(rawBody)` au lieu
  de lire `depositId`. JSON illisible ou référence absente → 400 (inchangé).
- `PayoutsService.handlePayoutWebhook` : idem via `extractPayoutRef` au lieu de `payoutId`.
- `PaymentsService.resolvePayment` : **seul `APPROVED` vaut paiement** (aujourd'hui
  `APPROVED || ACCEPTED`). `approvedCount > 1` → commandes en `REVIEW` (double débit à régulariser
  manuellement ; même chemin que la divergence de montant). `amount` absent → contrôle
  anti-divergence sauté (comportement existant).
- `PayoutsService.resolvePayout` : **seul `APPROVED` vaut `COMPLETED`** (aujourd'hui
  `APPROVED || ACCEPTED`).
- `OrderService.createOrder` : stocke `initResult.providerTxnId ?? null` dans `providerTxnId`.
- `PaymentsModule` : `{ provide: PAYMENT_PROVIDER, useClass: ArakaProvider }`.

## Règles de statut

**Agrégation de la réponse `byreference` (tableau) — `checkStatus` / `checkPayoutStatus` :**

| Cas | Résultat |
|---|---|
| Tableau vide | `PENDING` |
| ≥ 1 élément `APPROVED` | `APPROVED`, `approvedCount` = nombre d'`APPROVED` |
| Tous les éléments `DECLINED` | `DECLINED` |
| Sinon (`ACCEPTED`, `PENDING`, statut inconnu, mélange sans `APPROVED`) | `PENDING` |
| Réponse non tableau mais objet unique (format du manuel) | traité comme tableau à un élément |
| HTTP 401 | re-login + un nouvel essai, puis exception |
| HTTP 404 | `PENDING` (le reaper expirera après le TTL) |
| HTTP 500 / autre erreur / timeout | **exception** (statut inconnu — jamais `DECLINED`) |

Justification : un débit confirmé doit toujours être honoré ; un refus n'est retenu que s'il est
explicite et unanime ; une panne ARAKA ne doit jamais faire échouer un paiement réussi.

**Initiation de payout (`sendmobilemoney`)** : le service traite tout statut d'initiation autre que
`PENDING`/`ACCEPTED` comme un refus immédiat (reversal). ARAKA répond de façon synchrone
`200 SUCCESS`, qui **ne prouve pas** le crédit du destinataire. Traduction :

| Réponse | `InitPayoutResult.status` | Effet (existant) |
|---|---|---|
| `200` / `SUCCESS` ou `202` / `ACCEPTED` | `ACCEPTED` | Payout `PENDING`, confirmé par le reaper via `checkPayoutStatus` |
| `400` / `403` (refus explicite) | `DECLINED` | reversal immédiat, `FAILED` |
| `500`, erreur réseau, timeout | exception | Payout reste `PENDING`, réconcilié par le reaper |

## Flux

**Achat (inchangé pour le front).**
1. `POST /order` → réservation de stock + commandes `PENDING` avec `paymentRef` court →
   `initPayment` → `202 ACCEPTED` → réponse `PENDING` ; `providerTxnId` = `transactionId` ARAKA.
2. L'acheteur valide sur son téléphone.
3. Résolution par trois chemins, tous vers `resolvePayment(paymentRef)` → `checkStatus` :
   callback `POST /payments/webhook` (HMAC puis `extractPaymentRef`), polling
   `GET /order/:paymentRef/status` (throttlé), reaper (10 min, TTL `PAYMENT_PENDING_TTL_MINUTES`).
4. `PAID` (billets + ledger) / `FAILED` / `EXPIRED` / `REVIEW` — logique existante, idempotente.

**Retrait.** `initPayout` → `sendmobilemoney` → Payout `PENDING` → reaper → `resolvePayout` →
`checkPayoutStatus` → `COMPLETED` / `FAILED` (reversal) / `REVIEW` (bloqué). ARAKA ne documente pas
de callback de payout : résolution par le reaper (≤ 10 min). La route `/payments/payout-webhook`
reste en place (inerte tant qu'ARAKA ne l'appelle pas).

**Callback sans clé HMAC.** Tant que `ARAKA_CALLBACK_KEY` n'est pas fournie par ProxyPay, le webhook
répond 401 (fail-closed). Les paiements se résolvent quand même par le polling front et le reaper.
Aucun mode « accepter sans signature ».

## Configuration

| Variable | Rôle |
|---|---|
| `ARAKA_BASE_URL` | ex. `https://araka-api-uat.azurewebsites.net/api` (UAT) ; URL prod à obtenir |
| `ARAKA_EMAIL` | identifiant du compte marchand (idéalement un utilisateur API dédié) |
| `ARAKA_PASSWORD` | mot de passe associé — **secret**, uniquement `.env` / Render |
| `ARAKA_PAYMENT_PAGE_ID` | id de la Payment Page (fin de l'URL `/payment/xxxx`), différent UAT/prod |
| `ARAKA_CALLBACK_KEY` | clé HMAC des callbacks, fournie par ProxyPay sur demande — **secret** |

Supprimées : `PAWAPAY_BASE_URL`, `PAWAPAY_API_TOKEN`, `PAWAPAY_PUBLIC_KEY`.
Variables manquantes au démarrage (`ARAKA_BASE_URL`, `ARAKA_EMAIL`, `ARAKA_PASSWORD`,
`ARAKA_PAYMENT_PAGE_ID`) : log d'erreur explicite au boot ; les appels échouent proprement
(exception → compensation), sans crash du process.

## Suppression de PawaPay

- Supprimer `src/payments/pawapay.provider.ts` et `src/payments/pawapay.provider.spec.ts`.
- Nettoyer les mentions PawaPay : `CreateOrder.dto.ts` (commentaires + exemple d'opérateur),
  `payments.controller.ts` (commentaires RFC-9421), `payments.module.ts`, `CLAUDE.md` (section
  Config). (Pas de `.env.example` dans le repo.)
- Le `WebhookRequestContext` (méthode/chemin/authority) reste dans le contrat (inoffensif, ignoré
  par ARAKA) : le retirer n'apporte rien au présent objectif.

## Déploiement / bascule

- **Transactions en vol** : une commande PawaPay encore `PENDING` à la bascule sera interrogée chez
  ARAKA (inconnue → `PENDING` puis `EXPIRED` par le reaper : acceptable). Un **payout** PawaPay
  `PENDING` finirait en `REVIEW` sans résolution automatique → basculer en prod **uniquement
  quand aucun payout n'est `PENDING`**. Sur staging : sans enjeu.
- Ajouter à la checklist de déploiement : `ARAKA_CALLBACK_KEY` obligatoire en prod, URL de base
  prod, `ARAKA_PAYMENT_PAGE_ID` prod, utilisateur API dédié, suppression des `PAWAPAY_*` sur Render.
- Front : vérifier qu'aucun code opérateur PawaPay (`VODACOM_MPESA_COD`…) n'est codé en dur ;
  adapter logos/libellés aux codes `MPESA`/`ORANGE`/`AIRTEL`/`AFRIMONEY` servis par
  `GET /payments/config`.

## Tests

- `araka.provider.spec.ts` (`fetch` mocké) :
  - token : login unique puis réutilisation ; re-login à l'approche de `exp` ; re-login + un seul
    nouvel essai sur 401 ; exception si le second essai échoue.
  - `initPayment` : body exact (`walletID` préfixé `+`, `paymentPageId`, header
    `X-API-CALLBACK-MODE: 2`) ; `providerTxnId` renvoyé ; non-202 → exception.
  - `checkStatus` : chaque ligne du tableau « Agrégation » (vide, APPROVED, 2× APPROVED →
    `approvedCount: 2`, tous DECLINED, mélange, objet unique, 404, 500, timeout).
  - `verifyWebhookSignature` : vecteur HMAC-SHA256/Base64 connu valide ; corps altéré ; header
    absent ; clé absente ; signature de longueur différente.
  - `extractPaymentRef` / `extractPayoutRef` : champ présent, absent, JSON illisible.
  - `initPayout` : SUCCESS → `ACCEPTED` ; 400 → `DECLINED` ; 500 → exception ; `AFRIMONEY` →
    exception sans appel réseau.
  - `getOperators` : liste fixe.
- `transaction-ref.spec.ts` : longueur 20, préfixe `VB`, alphabet `A-Z2-7`, pas de doublon sur
  10 000 tirages.
- Specs existants ajustés : `payments.service.spec` (référence via `extractPaymentRef` ;
  `ACCEPTED` ≠ payé ; `approvedCount > 1` → `REVIEW`), `payouts.service.spec` (`ACCEPTED` ≠
  `COMPLETED` ; référence via `extractPayoutRef`), `Order.service.spec` (`providerTxnId`).
- Vérification finale : suite complète verte (`npm run test`), lint sans `--fix`
  (`npx eslint`), puis essai manuel sandbox en local via ngrok (numéros succès `+24381000000{1,2}`
  et échec `+24381000000{3,4}`), callback inspecté sur `localhost:4040`.

## Points en attente chez ProxyPay (ne bloquent pas l'implémentation)

1. Clé HMAC `ARAKA_CALLBACK_KEY` (sans elle, callbacks rejetés ; résolution par polling/reaper).
2. Statut d'un `sendmobilemoney` via `transactionstatusbyreference` : à confirmer.
3. Utilisateur API dédié, distinct du compte portail.
4. URL de base de production.

## Hors périmètre

- Coexistence multi-fournisseurs, choix de fournisseur par opérateur.
- Checkout hébergé (Payment Page en redirection) : on reste en push.
- Endpoints VAS (SNEL, Socodee, Liquid, airtime).
