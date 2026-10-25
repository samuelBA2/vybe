# Retrait partiel « Réclamer le net » — montant saisi + anti‑surfacturation

**Date :** 2026-10-25
**Statut :** Design validé (en attente relecture spec avant plan)
**Repos :** back `~/vybe` (`feat/payout-partial-amount`), front `~/vybeFrontend` (branche à créer)

## Contexte

La feature « Réclamer le net » (livrée sur la branche `feat/payout-claim-confirmation`,
désormais sur `main`) retire aujourd'hui **tout** le solde d'une devise en une fois :
`claimNet(userId, currency, mmoNumber)` crée une `PayoutClaim` avec `amount = bal.balance`
et débite le ledger `ORGANIZER` de `-bal.balance` dès la demande. Le formulaire front
(`ClaimNetSheet`) n'a qu'un champ numéro Mobile Money ; l'équipe Vybe confirme (statut) ou
rejette (statut + écriture ledger inverse qui restaure le solde) via magic‑link.

On veut passer au **retrait partiel** : l'organisateur saisit le **montant** à retirer,
avec un **minimum par retrait**, et une garantie forte **anti‑surfacturation**.

## Objectif

Permettre un retrait d'un **montant choisi** (≤ solde réel, ≥ minimum devise), déduit du
solde à la demande, sans jamais pouvoir réclamer plus que le solde détenu, et laisser
l'organisateur enchaîner un nouveau retrait sur le solde restant après la décision Vybe.

## Décisions validées (utilisateur)

1. **Seuil `1 USD` / `2500 CDF` = minimum PAR retrait ET condition d'accès.** Il faut au
   moins ce montant sur le compte pour lancer un retrait, et chaque demande doit être
   `≥ seuil`.
2. **Un seul retrait en attente à la fois** (modèle actuel conservé) : tant qu'une
   réclamation est `SENT`, pas de nouvelle demande.
3. **USD avec centimes** (2 décimales), **CDF entier** (cohérent avec la quantification
   `EarningsService`).
4. **Bouton OK après décision (CONFIRMED et CANCELLED)** : réinitialise le formulaire à
   l'état initial et réaffiche le **solde restant** rafraîchi (au lieu de fermer la fiche).

## Garde‑fous anti‑surfacturation (non négociable)

Le montant saisi côté front est **indicatif**. La **source de vérité est le serveur**.
Dans `claimNet`, **à l'intérieur** de la transaction verrouillée par
`pg_advisory_xact_lock(hashtext('payout:<userId>:<currency>'))` :

1. Re‑calcul du **solde réel** depuis le ledger **dans la même transaction**
   (`tx.ledgerEntry.aggregate(_sum amount, where userId+ORGANIZER+currency)`, puis
   `quantize` selon la devise).
2. Validations **bloquantes**, dans cet ordre :
   - montant **fini** et **`> 0`** ;
   - **précision** correcte : USD = 2 décimales max, CDF = entier
     (`quantize(amount, currency) === amount`) ;
   - **`≥ MIN_CLAIM_AMOUNT[currency]`** (1 USD / 2500 CDF) ;
   - **`≤ solde réel`** recalculé dans la tx.
3. Si une validation échoue → `BadRequestException` → **rollback, aucune déduction**.

Le ledger est débité **uniquement** du montant validé (`-amount`). Le rejet restaure
exactement `claim.amount` (logique existante de `PayoutModerationService.decide`, inchangée).

Conséquence : contourner le front (requête forgée) ne permet ni de dépasser le solde, ni
de contourner le minimum ou la précision. Le double‑clic reste couvert par le verrou
advisory + le re‑check « SENT existant » déjà en place.

## Comportement UX (`ClaimNetSheet`)

### Gate d'accès
- Solde disponible `< MIN_CLAIM[currency]` → pas de formulaire, message
  *« Solde trop faible pour un retrait (min 1 $ / 2 500 FC). »*

### Formulaire
- **Champ Montant** (en plus du numéro), `inputMode` numérique.
  - Pré‑rempli **vide**.
  - Bouton **« Max »** → met le solde disponible.
  - Aide affichée : *« Min : 1 $ · Dispo : <solde> »* (libellés formatés par devise).
- Validation client : `MIN ≤ montant ≤ disponible`, 2 décimales USD / entier CDF.
- Le bouton **« Réclamer le net »** reste désactivé tant que : numéro vide, case non
  cochée, montant invalide (hors bornes / mauvaise précision), ou mutation en cours.
- Message d'erreur sous le champ si montant hors bornes.

### Suivi (inchangé sur le principe)
- Barre de progression : ~50 % à l'envoi (`SENT`), 100 % à la confirmation.
- La barre affiche `formatMoneyIn(tracked.amount, currency)` = le **montant partiel**.
- « Renvoyer le message » (cooldown serveur 60 s) inchangé.

### Décision → OK réinitialise
- `CONFIRMED` : bouton **OK** → vide `montant` + `numéro`, oublie la réclamation suivie,
  **rafraîchit le solde** et réaffiche le formulaire avec le **solde restant**. Si le reste
  `< MIN`, bascule sur le message « solde trop faible ».
- `CANCELLED` (solde restauré) : **même comportement** — OK ramène au formulaire.
- Mécanique de « dismiss » : la fenêtre de reprise 15 min de `getCurrentClaim` fait que le
  serveur renvoie encore la réclamation terminée après décision. OK doit donc poser un
  **flag local `dismissedClaimId`** et ignorer `current.data` dont l'`id` correspond, pour
  que le formulaire réapparaisse réellement. (Sur rechargement dans les 15 min, la barre
  terminée peut réapparaître — edge case accepté en V1 : l'utilisateur reclique OK.)

## Changements techniques

### Backend (`~/vybe`)
- `src/common/constants.ts` : ajouter
  `export const MIN_CLAIM_AMOUNT: Record<Currency, number> = { USD: 1, CDF: 2500 };`
  (typé sur `$Enums.Currency`).
- `src/payments/dto/claim-net.dto.ts` (le DTO du body `POST /me/payouts/claim`) : ajouter
  `amount: number` (`@IsNumber()`, `@IsPositive()` ; validation fine précision/min/≤solde
  faite dans le service).
- `src/payments/payouts.service.ts` : `claimNet(userId, currency, mmoNumber, amount)` —
  - garder le fast‑path « réclamation SENT existante » (un seul à la fois) ;
  - **déplacer le calcul du solde dans la transaction** et appliquer les validations
    anti‑surfacturation ci‑dessus ;
  - créer la `PayoutClaim` avec `amount` (le montant validé) et le ledger `-amount`.
- `payouts.controller.ts` : passe `dto.amount` au service.
- **Aucune migration** (le modèle `PayoutClaim` porte déjà `amount`). Moderation service
  inchangé.

### Frontend (`~/vybeFrontend`)
- `src/types/api.ts` : `ClaimNetPayload` += `amount: number`.
- `src/services/payouts.service.ts` : `claimNet` envoie `amount` dans le body.
- `src/hooks/queries/use-payouts.ts` : `useClaimNet` **invalide la query du solde** au
  succès via `queryClient.invalidateQueries({ queryKey: queryKeys.earnings.summary })`
  (`["earnings","summary"]`, consommée par `useEarningsSummary` dans `Wallet.tsx`). Le solde
  « Disponible » du `ClaimNetSheet` vient de ce summary via la prop `amount`.
- `src/lib/payments.ts` : `export const MIN_CLAIM = { USD: 1, CDF: 2500 }` (miroir) + helper
  de validation/précision si utile.
- `src/components/vybe/ClaimNetSheet.tsx` : champ montant + bouton Max + aide min/dispo +
  validations + gate min + OK qui réinitialise (flag `dismissedClaimId`) et rafraîchit le
  solde.

## Tests

### Backend (`payouts.service.spec.ts`)
- montant `< MIN` → `BadRequestException`, aucune `PayoutClaim`, aucun ledger ;
- montant `> solde` → `BadRequestException`, **aucune déduction** ;
- mauvaise précision (USD 3 décimales, CDF non entier) → rejet ;
- montant valide partiel → `PayoutClaim.amount === montant`, ledger `-montant`, le solde
  restant = solde initial − montant ;
- une réclamation `SENT` existante → renvoyée sans nouvelle déduction (un seul à la fois) ;
- `MIN` respecté exactement (montant === MIN, montant === solde) → accepté.

### Frontend (`ClaimNetSheet.test.tsx`)
- gate : solde `< MIN` → message « solde trop faible », pas de formulaire ;
- champ montant : bouton désactivé si montant hors bornes / mauvaise précision ;
- bouton Max → remplit le solde disponible ;
- soumission valide → barre `SENT` affiche le montant partiel ;
- `CONFIRMED` → OK réaffiche le formulaire avec solde réduit ;
- `CANCELLED` → OK réaffiche le formulaire (solde restauré) ;
- CDF : refuse les décimales ; USD : accepte 2 décimales.

## Hors scope

- Pas de changement du flux magic‑link / mail (le mail affiche déjà `amount`).
- Pas de retraits multiples simultanés (décision 2).
- Pas de file d'attente ni d'historique enrichi.
- Pas de migration Prisma.
