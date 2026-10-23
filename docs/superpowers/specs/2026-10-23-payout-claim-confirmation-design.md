# Réclamation de paiement — confirmation par magic-link + barre de progression

Date : 2026-10-23
Portée : backend (`vybe`) + frontend (`vybeFrontend`)
Feature « Réclamer le net » (retrait manuel assisté V1)

## Contexte

Aujourd'hui « Réclamer le net » est un flux *fire-and-forget* :
`POST /me/payouts/claim` recalcule le solde net (ledger `ORGANIZER`), envoie un
mail à l'équipe Vybe (`MailService.sendPayoutClaimEmail`) et répond
`{ ok, amount, currency }`. **Aucune trace en base, aucun statut, aucune
confirmation.** Le client voit un accusé statique « Demande envoyée ».

On veut :

1. Un **bouton « Renvoyer »** côté client après l'envoi, au cas où il souhaite
   ré-expédier son message.
2. Une **barre de progression** (ligne qui avance) : elle avance d'un cran quand
   le mail est envoyé, et se **remplit** quand l'équipe Vybe confirme — même
   mécanique que la confirmation des mails de modération d'événement.
3. Côté équipe Vybe, dans le mail reçu, un **bouton de confirmation** (magic-link)
   qui met à jour les données chez l'utilisateur (statut → barre pleine).

## Décisions de conception (validées)

- **Le solde est déduit dès la demande** (pas à la confirmation). Confirmer ne
  fait que changer le statut.
- **Deux boutons dans le mail équipe** : **Confirmer** (→ `CONFIRMED`, aucun effet
  ledger, le solde est déjà déduit) et **Rejeter** (→ `CANCELLED` + écriture
  inverse qui **restaure le solde**). Sécurité en cas de mauvais numéro / fraude.
- **La barre survit au rechargement** : elle reprend l'état réel de la dernière
  réclamation (endpoint « réclamation en cours »).
- **Notifications in-app (cloche) : hors scope V1.** La barre fait office de
  retour visuel. Ajoutables plus tard sans refonte.
- **Une seule réclamation active (`SENT`) par (user, devise)** à la fois.

## 1. Modèle de données (Prisma + migration)

### Nouvel enum `PayoutClaimStatus`

```prisma
enum PayoutClaimStatus {
  SENT       // demande envoyée, solde déjà déduit, en attente équipe Vybe
  CONFIRMED  // équipe Vybe a confirmé l'envoi de l'argent
  CANCELLED  // équipe Vybe a rejeté → solde restauré
}
```

### Nouveau modèle `PayoutClaim`

```prisma
model PayoutClaim {
  id         String            @id @default(uuid())
  userId     String
  user       User              @relation(fields: [userId], references: [id])
  currency   Currency
  amount     Float             // montant figé au moment de la demande (= solde déduit)
  mmoNumber  String            // numéro Mobile Money de réception
  status     PayoutClaimStatus @default(SENT)
  jti        String            @unique // id du token magic-link (intégrité)
  createdAt  DateTime          @default(now())
  lastSentAt DateTime          @default(now()) // dernier envoi du mail (cooldown « Renvoyer »)
  decidedAt  DateTime?         // posé au CONFIRMED / CANCELLED

  @@index([userId, currency, status]) // « réclamation active » par devise
  @@index([userId, createdAt])        // reprise / historique
}
```

Ajouter la relation inverse `payoutClaims PayoutClaim[]` sur `User`.

### Nouvelle valeur d'enum `LedgerEntryType`

```prisma
enum LedgerEntryType {
  SALE_ORGANIZER
  SALE_PLATFORM
  REFUND_ORGANIZER
  PAYOUT_ORGANIZER   // NOUVEAU : retrait organisateur. Signé : négatif = déduction
                     // à la demande ; positif = restauration au rejet.
}
```

Le solde organisateur reste `Σ(amount) WHERE userId=X AND account=ORGANIZER` — la
logique de `EarningsService.getSummary` est **inchangée** ; elle agrège
automatiquement les nouvelles écritures `PAYOUT_ORGANIZER`.

> **Migration Neon** : 1 modèle + 2 changements d'enum. Base partagée → créer la
> migration mais **l'appliquer avec précaution** (cf. checklist prod,
> `docs/mise-en-prod.md`).

## 2. Flux backend

### Service `PayoutsService` (étendu)

**`claimNet(userId, currency, mmoNumber)`** — dans une `$transaction` :

1. Recalcule le solde `ORGANIZER` de la devise (`EarningsService`). Doit être > 0,
   sinon `BadRequestException('Aucun solde à réclamer dans cette devise.')`.
2. **Réclamation active ?** S'il existe déjà un `PayoutClaim` `SENT` pour
   `(userId, currency)` : on **ne crée pas** de 2ᵉ réclamation (pas de double
   déduction). On renvoie la réclamation existante (le front proposera « Renvoyer »).
3. Crée le `PayoutClaim` (`status=SENT`, `amount=solde`, `mmoNumber`,
   `jti=randomUUID()`).
4. Crée l'écriture `LedgerEntry` : `account=ORGANIZER`, `type=PAYOUT_ORGANIZER`,
   `amount = -solde`, `currency`.
5. Génère le token magic-link (JWT `{ sub: claim.id, type: 'payout-claim', jti }`,
   `expiresIn: '7d'`) et envoie le mail équipe avec les 2 liens.

Retourne le claim sérialisé (`id, status, amount, currency, mmoNumber, createdAt`).

**`resendClaim(userId, claimId)`** — charge le claim, vérifie
`claim.userId === userId` et `status === SENT`, régénère le token depuis le claim
(le `jti` reste celui du claim) et ré-expédie le mail. Aucune écriture ledger.
**Cooldown 60 s** porté par `claim.lastSentAt` : si `now - lastSentAt < 60s` →
`BadRequestException('Patiente avant de renvoyer.')` ; sinon ré-expédie et met
`lastSentAt = now`. `lastSentAt` est aussi posé à la création.

**`getCurrentClaim(userId, currency)`** — renvoie la **dernière** réclamation de
cette devise (`orderBy createdAt desc`, la plus récente), ou `null`. Sert le
polling et la reprise de la barre.

### Service `PayoutModerationService` (nouveau, calqué sur `EventModerationService`)

**`decide(token, decision: 'confirm' | 'reject')`** :

1. `jwtService.verify` → sinon `UnauthorizedException('Lien invalide ou expiré.')`.
2. `payload.type !== 'payout-claim'` → `ForbiddenException`.
3. Charge le `PayoutClaim` par `payload.sub`. Introuvable → `NotFoundException`.
4. `status !== SENT` → `ConflictException('Cette demande a déjà été traitée.')`
   (anti-rejeu naturel par le statut ; le `jti` du token sert l'intégrité).
5. Dans une `$transaction` :
   - **confirm** : `status=CONFIRMED`, `decidedAt=now`. **Aucune écriture ledger.**
   - **reject** : `status=CANCELLED`, `decidedAt=now`, **écriture ledger inverse**
     `PAYOUT_ORGANIZER` `amount = +claim.amount` (restaure le solde).
6. Retourne `{ message }` pour la page HTML.

### Controllers

**`PayoutsController`** (existant, guardé `JwtAuthGuard + RolesGuard + @Roles('USER')`,
préfixe `me/payouts`) :

- `POST claim` (existant) — inchangé en signature, renvoie désormais le claim.
- `POST claim/:id/resend` — `@HttpCode(200)`, scope `req.user.sub`.
- `GET claim/current?currency=` — renvoie le claim courant ou `null`.

**`PayoutModerationController`** (nouveau, **public, aucun guard**, préfixe
`payouts`, calqué sur les routes `/events/moderate`) :

- `GET decision?token=&decision=` — renvoie une **page HTML de confirmation** avec
  un bouton qui **POST** (empêche le prefetch du client mail de décider tout seul).
- `POST decision` body `{ token, decision }` — appelle `PayoutModerationService.decide`.

## 3. Mail équipe Vybe

`MailService.sendPayoutClaimEmail` gagne un paramètre `confirmUrl` / `rejectUrl`
(construits depuis `API_BASE_URL` + token) et rend **2 boutons** dans le HTML :

- **Confirmer** (vert) → `…/payouts/decision?token=…&decision=confirm`
- **Rejeter** (rouge) → `…/payouts/decision?token=…&decision=reject`

Conserve tout le détail actuel (identité organisateur, user ID, email, téléphone,
montant, numéro MMO). Ajoute une ligne d'explication :
*« Confirmer = l'argent a été envoyé (le solde du client est déjà déduit).
Rejeter = restaure le solde du client (ex. mauvais numéro). »*

> Les liens sont dans un mail interne à l'équipe ; on garde le garde-fou du POST
> (page HTML intermédiaire) comme pour la modération d'événement.

## 4. Frontend (`vybeFrontend`)

### Types (`src/types/api.ts`)

```ts
type PayoutClaimStatus = "SENT" | "CONFIRMED" | "CANCELLED";
interface PayoutClaim {
  id: string;
  status: PayoutClaimStatus;
  amount: number;
  currency: PaymentCurrency;
  mmoNumber: string;
  createdAt: string;
}
```

### Service (`src/services/payouts.service.ts`)

- `claimNet({ currency, mmoNumber })` → `PayoutClaim` (retour enrichi).
- `resendClaim(claimId)` → `{ ok: true }`.
- `getCurrentClaim(currency)` → `PayoutClaim | null`.

### Hooks (`src/hooks/queries/use-payouts.ts`)

- `useClaimNet` (existant, type de retour mis à jour).
- `useResendClaim` (mutation).
- `useCurrentClaim(currency)` — `useQuery` avec `refetchInterval` **tant que**
  `status === 'SENT'` (arrêt dès `CONFIRMED`/`CANCELLED`), comme l'écran d'attente
  de paiement (`Buy.tsx`).

### UI (`src/components/vybe/ClaimNetSheet.tsx`)

- **Reprise** : au montage, `useCurrentClaim(currency)`. Si un claim existe et
  n'est pas terminé il y a longtemps, afficher la barre ; sinon le formulaire.
- Après `submit` réussi, passer en mode « suivi » avec le claim retourné.
- **Barre de progression — 2 segments** (ligne animée CSS `transition: width`) :
  1. **« Demande envoyée »** — remplie (~50 %) dès `SENT` ;
  2. **« Confirmée par Vybe »** — se remplit à 100 % quand `status === CONFIRMED`.
  - `CANCELLED` : état distinct « Demande rejetée — ton solde a été restauré »
    (couleur neutre/alerte), bouton « OK ».
- **Bouton « Renvoyer le message »** visible tant que `status === SENT` (appelle
  `useResendClaim`, désactivé pendant la requête + cooldown 60 s côté UI aligné
  sur le back).
- Le montant affiché reste `formatMoneyIn(amount, currency)` (le claim porte
  `amount`).

## 5. Tests

### Backend
- `payouts.service.spec` : création **déduit** le solde (écriture `-montant`) et
  **crée** le `PayoutClaim` ; **bloque/renvoie** l'existant si un `SENT` existe ;
  `resendClaim` ré-envoie sans toucher au ledger + respecte le cooldown ;
  `getCurrentClaim` renvoie le bon claim.
- `payout-moderation.service.spec` : `confirm` → `CONFIRMED` sans écriture ledger ;
  `reject` → `CANCELLED` + écriture **+montant** (restaure) ; garde `status===SENT`
  (2ᵉ décision → `ConflictException`) ; token mauvais `type` → `Forbidden` ; token
  invalide → `Unauthorized`.
- Controllers : les routes `payouts/decision` sont **publiques** (pas de guard) ;
  `me/payouts/*` restent guardées `USER`.

### Frontend
- `ClaimNetSheet` : rendu des 3 états (SENT → barre ~50 %, CONFIRMED → 100 %,
  CANCELLED → message de restauration) ; bouton « Renvoyer » visible seulement en
  `SENT` et déclenche la mutation ; reprise via `useCurrentClaim`.
- `use-payouts` : `useCurrentClaim` arrête le polling à la décision.

## 6. Points de déploiement

- **Migration** à appliquer avec précaution (base Neon partagée).
- **Front + back déployés ensemble** (le front attend le retour enrichi du claim
  et les nouveaux endpoints).
- `API_BASE_URL` déjà requis (magic-links) — rien de nouveau en env.
- Branche back dédiée : `feat/payout-claim-confirmation` (depuis `main`). Prévoir
  la branche front équivalente.

## 7. Hors scope (V1)

- Notifications in-app (cloche) sur confirmation/rejet.
- Purge/expiration automatique des réclamations `SENT` jamais traitées.
- Paiement cashout self-service (toujours volontairement contourné).
