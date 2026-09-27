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
| Référence jamais utilisée sur `transactionstatusbyreference/{ref}` → **HTTP 404** | 404 = `PENDING`, expiré par le reaper au TTL |
| Aucun montant observé dans la réponse de statut | contrôle anti-divergence de montant non applicable |
| Une Payment Page créée en **USD** accepte un paiement **CDF** : 2 500 CDF affichés tels quels au portail (VBTEST0020) | **une seule** `ARAKA_PAYMENT_PAGE_ID` pour les deux devises |

Base URL UAT : `https://araka-api-uat.azurewebsites.net/api` (les chemins ci-dessous sont relatifs à
`/api`).

## Composants

### `src/payments/araka.provider.ts` (nouveau) — implémente `PaymentProvider`

| Méthode | Appel ARAKA | Traduction |
|---|---|---|
| *(privé)* `getToken()` | `POST /login` `{ emailAddress, password }` | Token gardé en mémoire jusqu'à `exp` − 60 s (décodage du payload JWT, sans vérification de signature ; à défaut TTL 1 h 50). Sur **401** d'un appel : un seul re-login + nouvel essai, puis exception. |
| `initPayment` | `POST /pay/paymentrequest`, header `X-API-CALLBACK-MODE: 2` | Body : `order{ paymentPageId: ARAKA_PAYMENT_PAGE_ID, transactionReference: paymentRef, amount, currency, redirectURL }`, `paymentChannel{ channel: 'MOBILEMONEY', provider: operator, walletID: '+' + phoneNumber }`. Réponse `statusCode` `202`/`ACCEPTED` → `{ paymentRef, providerTxnId: transactionId }`. Refus **explicite** (`400`/`403`) → `ProviderDeclinedError`. Tout le reste (`500`, réponse inattendue, erreur réseau, timeout) → exception ordinaire = **cas ambigu** (voir verrou V1). |
| `checkStatus` | `GET /reporting/transactionstatusbyreference/{paymentRef}` | Voir « Règles de statut ». |
| `verifyWebhookSignature` | — | HMAC-SHA256 (clé `ARAKA_CALLBACK_KEY` en UTF-8) sur le **corps brut** UTF-8 ; comparaison en temps constant avec `X-APP-SIGNATURE` décodé en **Base64** (exemple C# `VerifyCallback` du manuel). Clé absente, header absent, longueur différente → `false` (fail-closed). |
| `extractPaymentRef` | — | `JSON.parse(rawBody).originatingTransactionId` ; illisible/absent → `undefined`. |
| `extractPayoutRef` | — | Même champ (`originatingTransactionId`). Aucun callback payout n'est documenté : méthode présente pour le contrat. |
| `getOperators` | — (aucun endpoint) | Liste fixe : `MPESA`, `ORANGE`, `AIRTEL`, `AFRIMONEY`, `currencies: ['USD','CDF']`, `payoutAvailable: true` sauf `AFRIMONEY` (`false`). Un opérateur listé dans `ARAKA_DISABLED_OPERATORS` → `available: false`, `currencies: []`, `payoutAvailable: false` (verrou V7). |
| `initPayout` | `POST /pay/sendmobilemoney` | Body : `order{ transactionReference: payoutRef, amount, currency }`, `destination{ provider: operator, walletID: '+' + phoneNumber }`. Opérateur sans `payoutAvailable` → `DECLINED` **sans** appel réseau (défense en profondeur : normalement déjà refusé par `PayoutsService` avant le débit). Voir « Règles de statut ». |
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
- `ProviderOperator.payoutAvailable: boolean` — l'opérateur accepte-t-il les décaissements
  (ARAKA : pas `AFRIMONEY`). Le front filtre le sélecteur de retrait dessus.
- `export class ProviderDeclinedError extends Error` — levée par `initPayment` pour un refus
  **explicite** du fournisseur. Toute autre exception = issue inconnue.
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
- `OrderService.createOrder` : stocke `initResult.providerTxnId ?? null` dans `providerTxnId` ;
  verrous V1 (initiation ambiguë), V2 (débit), V3 (checkouts en cours), V4 (préfixe).
- `PaymentsCleanupService` : garde-fou 24 h du verrou V1.
- `PayoutsService.requestPayout` : verrous V4 (préfixe) et V8 (`payoutAvailable`) avant OTP/débit.
- `PaymentsModule` : `{ provide: PAYMENT_PROVIDER, useClass: ArakaProvider }`.

## Règles de statut

**Agrégation de la réponse `byreference` (tableau) — `checkStatus` / `checkPayoutStatus` :**

**Filtrage préalable (verrou V5)** : seuls les éléments dont `originatingTransactionId` (ou, à
défaut, `transactionReference`) est **strictement égal** à la référence interrogée sont retenus ;
les autres sont ignorés (log d'avertissement).

| Cas (après filtrage) | Résultat |
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

## Verrous de sécurité (V1)

**V1 — Initiation ambiguë ≠ échec (bug existant, corrigé).** Aujourd'hui toute exception de
`initPayment` passe les commandes en `FAILED` + stock relâché ; or un timeout/500 ne prouve pas
qu'ARAKA n'a rien fait : l'acheteur peut valider et être débité, et le reaper ne revoit jamais un
`FAILED` → débit sans billet. Nouveau comportement de `OrderService.createOrder` :
- `ProviderDeclinedError` → compensation existante (`FAILED` + stock relâché) + `400`
  « Paiement refusé par l'opérateur. »
- toute autre exception → commandes **laissées `PENDING`**, log d'erreur, réponse normale
  `{ paymentRef, status: 'PENDING', … }` : le front poll, le reaper tranche après le TTL.
- Garde-fou : si le reaper voit un checkout `PENDING` depuis plus de **24 h** dont `checkStatus`
  lève encore une exception, il l'**expire** (`EXPIRED` + stock relâché ; un paiement tardif reste
  ré-honorable) avec un log d'erreur, pour qu'aucun stock ne reste bloqué indéfiniment.
- Vérifié en sandbox : `byreference` sur une référence **jamais utilisée** (`VBJAMAISUTILISE`)
  renvoie **404** → `PENDING` → le reaper l'expire dès le TTL (25 min) comme un paiement abandonné.
  Le garde-fou 24 h ne sert donc qu'en cas d'erreurs 500 persistantes côté ARAKA.

**V2 — Anti-harcèlement par push USSD.** Sans limite, un compte peut déclencher des prompts de
paiement en boucle vers le numéro d'un tiers. Sur `POST /order`, avant toute réservation :
- `@Throttle` : 10 requêtes / min par IP (au lieu de la limite globale 20/min).
- Fenêtre glissante **en mémoire** : 3 initiations / 10 min **par numéro** (clé = SHA-256 du
  numéro, jamais le numéro en clair) et 5 initiations / 10 min **par utilisateur** → `429`.
- Limite assumée : compteurs par instance, remis à zéro au redémarrage (Render = 1 instance).

**V3 — Anti-blocage de stock.** Au plus **2 checkouts `PENDING`** simultanés par utilisateur
(compte des `paymentRef` distincts `PENDING` en base) → `429` « Un paiement est déjà en cours. »

**V4 — Cohérence opérateur ↔ numéro.** `phoneNumber` (chiffres, indicatif `243` inclus) doit
correspondre à l'opérateur choisi, à l'achat **et** au retrait → sinon `400` « Ce numéro ne
correspond pas à l'opérateur choisi. » Préfixes (après `243`), exposés dans
`ProviderOperator.phonePrefixes` pour que le front valide aussi :

| Opérateur | Préfixes |
|---|---|
| `MPESA` | `81`, `82`, `83` |
| `ORANGE` | `80`, `84`, `85`, `89` |
| `AIRTEL` | `97`, `98`, `99` |
| `AFRIMONEY` | `90`, `91` |

Préfixes usuels RDC, cohérents avec les numéros de test ARAKA — **à confirmer par ProxyPay**
(constante unique dans `araka.provider.ts`).
Format : le front normalise déjà en `243` + 9 chiffres (`normalizeMobileNumber`,
`vybeFrontend/src/lib/payments.ts`). La DTO (`CreateOrder.dto.ts`, `request-payout.dto.ts`) est
resserrée de `^\d{6,15}$` à `^243\d{9}$`, et son commentaire (« sans préfixe international »,
faux) corrigé.

**V5 — Filtrage strict des réponses de statut** : voir « Règles de statut ».

**V6 — Transport chiffré.** `ArakaProvider` refuse de démarrer (exception au boot) si
`ARAKA_BASE_URL` ne commence pas par `https://` : le mot de passe marchand et le token ne doivent
jamais circuler en clair. (Variables manquantes : log d'erreur sans crash, cf. Configuration ;
variable **dangereuse** : échec immédiat.)

**V7 — Interrupteur manuel d'opérateur.** `ARAKA_DISABLED_OPERATORS` (ex. `ORANGE,AIRTEL`) :
opérateurs servis `available: false` / `payoutAvailable: false` par `GET /payments/config` → grisés
et non cliquables au front (déjà géré : `Buy.tsx`, `WithdrawSheet.tsx`), et refusés côté
backend par les gardes existantes de `createOrder` / `requestPayout`. Changer la variable sur
Render redéploie le service (quelques minutes).

**V8 — Opérateur de retrait supporté.** `PayoutsService` refuse (`400`), **avant l'OTP et le
débit**, un opérateur sans `payoutAvailable` (ex. `AFRIMONEY`). Sans ce verrou, l'exception de
`initPayout` surviendrait après le débit et laisserait le retrait bloqué en `PENDING`.

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
| `ARAKA_DISABLED_OPERATORS` | optionnelle, liste séparée par des virgules (ex. `ORANGE`) : opérateurs grisés (verrou V7) |

`ARAKA_BASE_URL` doit commencer par `https://`, sinon refus de démarrer (verrou V6).

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
  `GET /payments/config` ; filtrer le sélecteur de retrait sur `payoutAvailable` ; valider le
  préfixe du numéro avec `phonePrefixes` (message clair avant envoi) ; afficher le 429 (V2/V3).

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
  - `getOperators` : liste fixe ; `AFRIMONEY` sans `payoutAvailable` ; `phonePrefixes` ;
    `ARAKA_DISABLED_OPERATORS` → `available: false`, `currencies: []`, `payoutAvailable: false`.
  - `checkStatus` : élément dont la référence diffère → ignoré (V5).
  - `initPayment` : 400/403 → `ProviderDeclinedError` ; 500/timeout → exception ordinaire.
  - Démarrage avec `ARAKA_BASE_URL` en `http://` → exception (V6).
  - `initPayout` opérateur sans `payoutAvailable` → `DECLINED` sans appel réseau.
- `transaction-ref.spec.ts` : longueur 20, préfixe `VB`, alphabet `A-Z2-7`, pas de doublon sur
  10 000 tirages.
- Specs existants ajustés : `payments.service.spec` (référence via `extractPaymentRef` ;
  `ACCEPTED` ≠ payé ; `approvedCount > 1` → `REVIEW`), `payouts.service.spec` (`ACCEPTED` ≠
  `COMPLETED` ; référence via `extractPayoutRef` ; V4 et V8 refusés **sans** débit ni OTP),
  `Order.service.spec` (`providerTxnId` ; V1 : `ProviderDeclinedError` → `FAILED` + 400, timeout →
  reste `PENDING` sans relâcher le stock ; V2 : 4e initiation sur un même numéro en 10 min → 429 ;
  V3 : 3e checkout `PENDING` → 429 ; V4 : préfixe incohérent → 400 sans réservation de stock),
  `payments.cleanup.spec` (V1 : exception > 24 h → `EXPIRED` ; < 24 h → inchangé).
- Vérification finale : suite complète verte (`npm run test`), lint sans `--fix`
  (`npx eslint`), puis essai manuel sandbox en local via ngrok (numéros succès `+24381000000{1,2}`
  et échec `+24381000000{3,4}`), callback inspecté sur `localhost:4040`.

## Points en attente chez ProxyPay (ne bloquent pas l'implémentation)

1. Clé HMAC `ARAKA_CALLBACK_KEY` (sans elle, callbacks rejetés ; résolution par polling/reaper).
2. Statut d'un `sendmobilemoney` via `transactionstatusbyreference` : à confirmer.
3. Utilisateur API dédié, distinct du compte portail.
4. URL de base de production.
5. Confirmation des préfixes téléphoniques par opérateur (verrou V4).

## Hors périmètre

- Coexistence multi-fournisseurs, choix de fournisseur par opérateur.
- Checkout hébergé (Payment Page en redirection) : on reste en push.
- Endpoints VAS (SNEL, Socodee, Liquid, airtime).
- Reportés à une étape suivante : délai de sécurité avant un premier retrait vers un nouveau
  numéro ; limite de débit dédiée sur `/payments/webhook` ; rapprochement quotidien ARAKA ↔ ledger
  et procédure de remboursement des doubles débits ; coupe-circuit automatique par opérateur.
