# Paiement réel (fournisseur à décider) — Design

Date : 2026-09-09
Repo : backend `/Users/user/vybe` (NestJS + Prisma + Postgres/Neon)
Remplace : le **stub** `OrderService.createOrder` (`src/orders/Order.service.ts`) qui crée
aujourd'hui des `Order` en `paymentStatus: 'PAID'` en dur et génère les billets immédiatement.

**Fournisseur : NON ARRÊTÉ.** Ce design est volontairement **agnostique du fournisseur** : tout le
cœur (modèle de données, ledger, transition `PAID`, reaper, comptabilité) est indépendant du
prestataire. Les points qui dépendent réellement de l'intégration choisie sont **isolés et marqués
« à finaliser au choix du fournisseur »**. Candidats évalués : agrégateurs Mobile Money RDC
(CinetPay, ARAKA/ProxyPay, FlexPay, etc.).

## Objectif

Passer d'un encaissement fictif à un vrai paiement Mobile Money : l'acheteur paie, le fournisseur
notifie par webhook/callback, on **re-vérifie côté serveur** (jamais le seul callback), et seulement
alors on génère les billets **et** on crédite les comptes (85 % organisateur / 15 % plateforme).

## Deux formes d'intégration possibles (axe à trancher au choix du fournisseur)

Les agrégateurs se répartissent en deux modèles ; l'interface `PaymentProvider` doit couvrir **les
deux**, et le choix du fournisseur fixera lequel s'applique :

- **A. Checkout hébergé (redirect).** On initie → le fournisseur renvoie une `paymentUrl` → le front
  **redirige** l'acheteur vers la page du fournisseur → retour navigateur + webhook. (ex. CinetPay.)
- **B. Push Mobile Money (push + poll).** L'acheteur choisit opérateur + numéro **dans l'UI Vybe** →
  on pousse la demande → prompt USSD sur son téléphone → callback + status inquiry. **Pas de
  `paymentUrl`.** (ex. ARAKA.)

Ce qui **change selon A/B** (donc à finaliser au choix) : les champs d'entrée de `POST /order`
(un provider push exige `operateur` + `numéro`), la forme de sortie (`paymentUrl` vs simple accusé
+ polling), le comportement du frontend (redirection vs écran « validez sur votre téléphone »), la
longueur/format autorisés de la référence de transaction, et l'algorithme exact de signature du
webhook. **Tout le reste ci-dessous est indépendant de A/B.**

## Périmètre (V1) — décisions déjà prises (indépendantes du fournisseur)

- **Provider abstrait `PaymentProvider`** : brancher/changer de fournisseur sans toucher au flux.
- **V1 = collecte uniquement.** Le **payout (retrait organisateur) est Lot 2**.
- **Ledger dès la V1** (Option B) : le passage `PAID` écrit des écritures de crédit signées dans la
  **même transaction** que la génération des billets. Solde organisateur = `SUM(ledger)`.
- **`EXPIRED` distinct de `FAILED`** ; **`REVIEW`** = paiement accepté mais non résolvable auto
  (règle absolue : un paiement accepté ne reste jamais sans résolution).
- **Taux de change figé en env** (`USD_TO_CDF_RATE`) pour la V1.
- **Mobile Money d'abord** ; carte (VISA/Mastercard) = Lot 2 sauf si le fournisseur retenu la fournit
  trivialement.
- **GIFT inchangé** : billets offerts créés immédiatement, hors paiement.

## Modèle de flux de fonds (custody & settlement) — vrai pour tout agrégateur

**L'argent physique** et **le ledger** sont séparés : le ledger décrit des *créances*, il ne détient
pas d'argent. Un agrégateur encaisse **100 % de l'argent sur le compte marchand de Vybe** ; le split
85/15 est **virtuel** (ledger DB uniquement).

```
Acheteur paie
        │
        ▼
 Compte marchand (fournisseur) de VYBE   ← 100 % ici, settlé vers le compte de Vybe selon le presta
        │
        ├─ Ledger DB : + organizerAmount (ORGANIZER) = DETTE de Vybe envers l'organisateur (IOU)
        └─ Ledger DB : + platformFee     (PLATFORM)  = REVENU de Vybe
```

- **15 % plateforme** : jamais « retirés » — Vybe détient déjà 100 % du pool. La ligne
  `SALE_PLATFORM` reconnaît le revenu, aucun mouvement réel.
- **« Wallet organisateur »** = solde comptable `SUM(ledger WHERE userId, account=ORGANIZER)`, une
  reconnaissance de dette ; le cash est mutualisé dans le compte du fournisseur.

**Payout (Lot 2)** : selon le fournisseur (beaucoup font le B2C nativement), débit ledger
`PAYOUT_ORGANIZER` (< 0) + versement Mobile Money. Contraintes Lot 2 : **solde disponible (settlé) ≠
solde ledger brut** (ne pas avancer l'argent non settlé) ; **détention de fonds d'autrui =
réglementé** (agrément monnaie électronique / transmission de fonds : RDC = Code du numérique
loi n°23/010, BCC/EME ; France/UE = DSP2, établissement de paiement/EME) — un fournisseur agréé
allège (sans annuler) le sujet ; à faire valider par un juriste avant prod (bloquant prod).

## Architecture — abstraction `PaymentProvider`

Nouveau module `src/payments/`. Interface couvrant les deux formes d'intégration :

```ts
type ProviderStatus = 'ACCEPTED' | 'APPROVED' | 'DECLINED' | 'PENDING';

interface PaymentProvider {
  // Initie le paiement. Selon le fournisseur, renvoie soit une paymentUrl (checkout hébergé),
  // soit un simple accusé (push Mobile Money). Les champs d'init spécifiques (opérateur, numéro)
  // sont portés par un type d'entrée dépendant du fournisseur.
  initPayment(input: InitPaymentInput): Promise<{ paymentRef: string; paymentUrl?: string }>;

  // Re-vérifie le statut côté serveur par NOTRE référence (source de vérité, jamais le seul callback).
  checkStatus(paymentRef: string): Promise<{ status: ProviderStatus; amount?: number; currency?: string }>;

  // Vérifie l'authenticité d'un webhook/callback (signature/HMAC/token propre au fournisseur).
  verifyWebhookSignature(rawBody: string, headers: Record<string, string>): boolean;
}
```

Token d'injection `export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER')`. L'implémentation
concrète (`<Provider>Provider`) est écrite **une fois le fournisseur choisi** ; elle utilise `fetch`
natif (aucune dépendance). Chaque échange est loggé pour audit/réconciliation (`PaymentProviderLog`).

## Modèle de données (1 migration) — indépendant du fournisseur

### `Order` — ajouts
```prisma
currency          Currency @default(USD)   // devise réellement débitée
chargedAmount     Float                    // part de CETTE commande dans le montant débité
providerTxnId     String?                  // id fournisseur (trace/réconciliation)
// totalAmount/platformFee/organizerAmount restent en USD (base comptable).
// paymentRef (déjà présent) = référence de transaction PARTAGÉE par les N commandes d'un checkout.
// Format/longueur de paymentRef : à finaliser au choix du fournisseur (certains limitent à 20 car.).
@@index([paymentRef])
```
`enum Currency { USD CDF }`. Données personnelles (ex. numéro Mobile Money) **non persistées**
(minimisation) — seulement utilisées à l'appel.

### `PaymentStatus` — ajouts
```prisma
enum PaymentStatus {
  PENDING
  PAID
  FAILED     // paiement refusé
  EXPIRED    // NOUVEAU : PENDING abandonné / timeout (stock relâché)
  REVIEW     // NOUVEAU : accepté mais non résolvable auto (résolution manuelle)
  REFUNDED   // (Lot 2)
  GIFT
}
```

### `LedgerEntry` — source de vérité des soldes
```prisma
enum LedgerAccount   { ORGANIZER PLATFORM }
enum LedgerEntryType { SALE_ORGANIZER SALE_PLATFORM REFUND_ORGANIZER PAYOUT_ORGANIZER }

model LedgerEntry {
  id        String          @id @default(uuid())
  account   LedgerAccount
  userId    String
  user      User            @relation(fields: [userId], references: [id])
  type      LedgerEntryType
  amount    Float           // SIGNÉ : crédits > 0, débits (payout) < 0
  currency  Currency        @default(USD)   // ledger en USD = base comptable
  orderId   String?
  eventId   String?
  createdAt DateTime        @default(now())

  @@index([userId, account])
  @@index([userId, createdAt])
  @@index([orderId])
}
```
Back-relation `ledgerEntries LedgerEntry[]` sur `User`. Solde organisateur =
`SUM(amount) WHERE userId=X AND account=ORGANIZER`.

### `PaymentProviderLog` — audit (séparé du ledger)
```prisma
model PaymentProviderLog {
  id           String   @id @default(uuid())
  paymentRef   String
  direction    String   // 'INIT' | 'CHECK' | 'WEBHOOK' | 'AUTH'
  requestBody  Json?
  responseBody Json?
  status       String?
  createdAt    DateTime @default(now())
  @@index([paymentRef])
}
```

Migration Prisma dédiée. **Ne PAS lancer `prisma format`.** `migrate dev` réservé à l'utilisateur.

## Flux (endpoints)

### 1. `POST /order` (auth `USER`) — initie le paiement, ne crée AUCUN billet
`CreateOrderDto` reçoit en plus `currency`. *(Champs supplémentaires — ex. opérateur + numéro pour un
fournisseur push — à ajouter au choix du fournisseur.)* Déroulé :
1. Gardes métier actuelles (doublon panier, `PUBLISHED`, deadline, `maxPerOrder`) — avant transaction.
2. Génère `paymentRef` partagé par toutes les lignes *(format selon fournisseur)*.
3. Transaction : réservation stock (raw UPDATE anti-survente, inchangé) + N `Order` **`PENDING`**
   partageant `paymentRef`, `currency`, montants USD, `chargedAmount` (USD → totalAmount ; CDF →
   `totalAmount * USD_TO_CDF_RATE`). **Aucun billet.**
4. `chargedTotal = Σ chargedAmount` (entier si CDF). `provider.initPayment({...})`.
5. Retour : `{ paymentRef, currency, chargedAmount }` **+ `paymentUrl` si checkout hébergé**, sinon
   `status: 'ACCEPTED'` (push). *(Forme finalisée au choix du fournisseur.)*
6. **Si l'init échoue** → orders du `paymentRef` en `FAILED` + stock relâché ; rethrow.

### 2. `POST /payments/webhook` (public) — notification fournisseur
1. `verifyWebhookSignature` → sinon `UnauthorizedException` (401), stop.
2. Extraire `paymentRef`. `provider.checkStatus(paymentRef)` (re-vérification serveur défensive).
3. Si le fournisseur renvoie un montant : vérifier `amount == Σ chargedAmount` attendu →
   divergence → `REVIEW`. *(Certains providers n'exposent pas le montant ; s'il est fixé par nous à
   l'init et non altérable, ce contrôle est sans objet — à confirmer au choix du fournisseur.)*
4. Transition **atomique** de toutes les commandes du `paymentRef`, gardée `WHERE paymentStatus IN
   ('PENDING','EXPIRED')` (idempotent) :
   - `APPROVED`/`ACCEPTED payé` + stock tenu → **`PAID`** : billets (`qrToken`, `expiresAt=
     event.endDate`) **+** `LedgerEntry` (`SALE_ORGANIZER`/`SALE_PLATFORM`) par commande, même
     transaction. Order `EXPIRED` + stock dispo → re-honore ; stock reparti → **`REVIEW`**.
   - `DECLINED` → **`FAILED`** + stock relâché.
   - `PENDING` → no-op.

### 3. `GET /order/:paymentRef/status` (auth `USER`, propriétaire)
Le front poll (retour navigateur ou écran d'attente). Renvoie le statut agrégé + `ticketIds` si
`PAID`. Scoping strict `req.user.sub`. Neutre si pas à soi.

## Reaper (cron) — `src/payments/payments.cleanup.ts`

Backstop si l'acheteur abandonne ou si le callback n'arrive pas.
- `PAYMENT_PENDING_TTL_MINUTES` (défaut **25**, > durée de vie du paiement côté fournisseur). Pour
  chaque `Order` `PENDING` > TTL : `provider.checkStatus` **d'abord** — si payé → même chemin que le
  webhook (`PAID`+billets+ledger) ; sinon → `EXPIRED` + `soldCount` relâché.

## Comptabilité organisateur (solde profil + page compta)

La carte « TOTAL BILLETS VENDUS » du profil (front) est du **mock** ; aucun endpoint n'agrège les
ventes d'un organisateur au niveau profil. Le ledger le rend trivial.
- **Carte = NET 85 % = solde disponible/retirable** (pas le brut). V1 = net cumulé.
- **Devise d'affichage : CDF (« FC »)**, converti depuis l'USD au taux `USD_TO_CDF_RATE`.
- **Clic → page « Comptabilité », lecture seule V1** : solde + ventilation (brut · commission 15 % ·
  net) + historique ventes. Bouton **« Retirer » = Lot 2**.
- Backend : `GET /me/earnings` (agrégat ledger scopé `req.user.sub`) + `GET /me/earnings/history`
  (ledger `account=ORGANIZER`, keyset paginé). Brut/commission ← agrégat `Order` PAID
  (`ticketCategory.event.createdById`).

## Points de correction / impacts

1. **Contrat `POST /order` cassé (attendu)** : ne renvoie plus `{ orderIds, tickets }`. Forme exacte
   (redirect vs push) finalisée au choix du fournisseur. Frontend à adapter (spec front séparée).
2. **Split crédité au `PAID`** via `LedgerEntry` (calculer ≠ créditer).
3. **Course reaper ↔ callback tardif** : TTL + `checkStatus` défensif + callback résolvant aussi
   `EXPIRED` (garde `IN('PENDING','EXPIRED')`). Cas stock reparti → `REVIEW`.
4. **`MyTickets.service.ts`** : filtre `{ not: 'GIFT' }` → **`'PAID'`**.
5. **Dashboard scan (`agent.service.ts`) inchangé** (agrégat `Order` PAID par événement).
6. **Ledger = USD** ; conversion CDF au payout (Lot 2).
7. **Audit/réconciliation** via `PaymentProviderLog` + `paymentRef`/`providerTxnId`.

## Env

`USD_TO_CDF_RATE`, `PAYMENT_PENDING_TTL_MINUTES` (défaut 25), `API_BASE_URL` (déjà présent) pour le
webhook/return. **Les identifiants du fournisseur (clés API / credentials / clé de signature) seront
ajoutés au choix du fournisseur.**

## Tests

- `PaymentProvider` (mock `fetch`) : `initPayment` (forme selon fournisseur), `checkStatus` (mapping
  statuts), `verifyWebhookSignature` (rejet du bruit).
- `OrderService.createOrder` réécrit : `PENDING` + `paymentRef` partagé + stock réservé + init
  appelée + **aucun billet** ; `chargedAmount` USD/CDF ; échec init → `FAILED` + stock relâché.
- Webhook : signature invalide → 401 ; payé → `PAID` + billets + 2 ledger/commande ; idempotence ;
  `EXPIRED` stock dispo → re-honore ; stock reparti → `REVIEW` ; refusé → `FAILED` + stock relâché.
- `GET /order/:paymentRef/status` (ownership, agrégat, ticketIds si PAID).
- Reaper (`EXPIRED` + stock relâché ; payé → `PAID`).
- Ledger + `GET /me/earnings`(+history) : scope, conversion CDF, cohérence net.

## Hors périmètre (Lot 2)

Payout (retrait organisateur), `REFUNDED`, carte, taux live, multi-fournisseur actif, notification
acheteur au `PAID` (à rebrancher au merge avec `feat/notifications`).

## Séquencement

Migration → interface `PaymentProvider` → réécriture `createOrder` → webhook → `GET /status` →
reaper → comptabilité → `MyTickets`. **L'implémentation concrète du provider et la finalisation du
contrat `POST /order` attendent le choix du fournisseur.** Migration + code déployés ensemble.
