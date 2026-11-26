# Vybe — Feature Spec : Réservation de billets (sans mobile money)

> Handoff pour session Claude Code. Stack cible : NestJS · Prisma · PostgreSQL (Neon) · React.
> Réutilise les patterns Vybe existants : décréments SQL atomiques (anti-oversell), tokens QR opaques, ledger double-entrée, outbox/BullMQ.

---

## 1. Objectif

Permettre aux clients **sans mobile money** de réserver un billet et de **payer en cash à la porte**, sans que la réservation devienne une entrée gratuite. Le levier : un billet réservé a un **QR distinct** qui, au scan, n'ouvre pas l'accès (vert) mais affiche un **pop-up de recouvrement** (jaune), et l'agent encaisse ou annule sur place.

---

## 2. Règles métier (figées)

1. **Périmètre** : la réservation n'est possible que pour **une seule catégorie par événement** (la catégorie d'entrée / « 1ʳᵉ catégorie »). Marquée par un flag sur la catégorie, pas en dur.
2. **Plafond** : **50 réservations actives max** par événement (configurable par catégorie, défaut 50).
3. **Limite par compte** : **1 réservation active par utilisateur**. Si l'utilisateur a déjà une réservation active → bouton `Réserver` grisé/non cliquable.
4. **Saturation** : quand le plafond (50/50) est atteint → bouton `Réserver` grisé pour **tous** les utilisateurs.
5. **Atomicité** : création de réservation atomique (pas de 51ᵉ en cas de clics simultanés), même mécanisme que les décréments de stock.
6. **Collecte de contact obligatoire** : nom, prénom, téléphone, avec disclaimer litige.
7. **QR réservé = usage unique et conscient du statut** : après action de l'agent (Encaisser **ou** Supprimer), le QR est **invalidé immédiatement** — un QR partagé/capturé ne sert plus à rien.
8. **Confirmation** sur `Supprimer le billet` (action destructive).
9. **Agents = équipe Vybe** (confiance), mais chaque action `Encaisser` / `Supprimer` est **horodatée et attribuée à l'agent** (réconciliation du cash en fin d'événement, pas méfiance).
10. **Reporté (assumé)** : vérification OTP du téléphone, et cutoff d'expiration des réservations non honorées.

---

## 3. Parcours utilisateur (frontend)

### Page événement `vybeplatform.app/events/:id`
- Bouton **`Acheter`** (ancien bouton, renommé — paiement immédiat habituel).
- Nouveau bouton **`Réserver`** (visible seulement si la catégorie d'entrée a la réservation activée).
- États du bouton `Réserver` :
  - **Actif** : réservations < 50 ET l'utilisateur n'a pas de réservation active.
  - **Grisé / non cliquable** : utilisateur a déjà réservé, OU 50/50 atteint.

### Pop-up `Réserver`
Champs : **Nom**, **Prénom**, **Téléphone**.
Message au-dessus :
> « Ces informations permettront à Vybe de vous contacter en cas de litige de paiement ou de problème technique lié à la réservation de vos places. Veuillez saisir des informations réelles qui permettront à l'équipe de remonter jusqu'à vous. »

Bouton **`Envoyer`** → crée la réservation → le billet apparaît dans l'onglet **Ticket** de l'utilisateur, avec un **badge visible « Billet réservé »**. Le QR de ce billet est **distinct** d'un billet payé.

---

## 4. Parcours agent (scan à la porte)

Au scan d'un QR :
- **Billet payé** → écran **vert** (accès) + billet marqué `USED` (usage unique).
- **Billet réservé** → **pop-up jaune** :
  > « Billet réservé — cet utilisateur vous doit **$X** »
  > (X = prix de la catégorie du billet réservé)

  Deux boutons :
  - **`Encaisser`** → l'agent a reçu le cash. Effets :
    1. Montant **ajouté au ledger** (section « Total encaissement billets réservés »).
    2. Billet marqué **payé + admis** (`USED`, `paidAtGate = true`).
    3. Compteur de réservations **inchangé** (la réservation reste comptée parmi les 50) ; apparaît dans le carré **« Réservé-puis-payé »**.
    4. **QR invalidé** (usage unique).
  - **`Supprimer le billet`** (avec **confirmation**) → l'utilisateur ne paie pas / part. Effets :
    1. Réservation annulée (`CANCELLED`), **aucun montant** ajouté.
    2. Compteur de réservations **décrémenté** (ex. 50 → 49 : la place ne tient plus).
    3. **QR invalidé**.

> Dans **les deux cas**, le QR est mort après le clic.

---

## 5. Dashboard — compteurs (3 blocs distincts)

1. **Compteur de réservations** — `X / 50`
   `+1` à chaque réservation créée (jusqu'à 50) · `−1` uniquement sur `Supprimer`. **`Encaisser` ne le change pas** : une fois à 50, il **reste à 50** (sauf suppression). Ce compteur mesure les réservations qui tiennent, **pas** le paiement.
2. **Réservé-puis-payé** (carré dédié)
   Nombre de réservations **encaissées** à la porte — combien des 50 ont vraiment payé.
3. **Total encaissement billets réservés** — `$`
   `+prix de la catégorie` à chaque `Encaisser` uniquement. Reste à **0** tant qu'aucun agent n'a encaissé, même si 50 réservations existent. **C'est l'indicateur de paiement réel** : s'il n'est plus à 0 et monte, les réservations se transforment en argent.

---

## 6. Modèle de données (Prisma — à adapter au schéma existant)

```prisma
enum TicketStatus {
  VALID        // payé en ligne, pas encore scanné
  USED         // scanné et admis (usage unique)
  RESERVED     // réservé, non payé
  CANCELLED    // réservation supprimée par l'agent
}

enum ReservationResolution {
  PENDING      // en attente de passage à la porte
  COLLECTED    // encaissé cash à la porte
  DELETED      // supprimé par l'agent
}

model TicketCategory {
  id                  String   @id @default(cuid())
  eventId             String
  name                String
  priceCents          Int
  // --- réservation ---
  reservationEnabled  Boolean  @default(false) // "1ʳᵉ catégorie" = celle à true
  reservationCap      Int      @default(50)
  reservedCount       Int      @default(0)      // réservations qui tiennent : +1 réserve, −1 supprime, INCHANGÉ à l'encaissement
  // ...
  tickets             Ticket[]
  @@index([eventId])
}

model Ticket {
  id              String        @id @default(cuid())
  eventId         String
  categoryId      String
  category        TicketCategory @relation(fields: [categoryId], references: [id])
  userId          String
  status          TicketStatus  @default(VALID)
  qrToken         String        @unique // token opaque ; le scan résout par ce token
  usedAt          DateTime?

  // --- champs réservation ---
  isReservation   Boolean       @default(false)
  resolution      ReservationResolution?
  holderFirstName String?
  holderLastName  String?
  holderPhone     String?
  reservedAt      DateTime?
  resolvedAt      DateTime?
  resolvedByAgent String?       // id de l'agent (attribution / réconciliation)
  paidAtGate      Boolean       @default(false)

  createdAt       DateTime      @default(now())
  @@index([eventId, userId])
  @@index([qrToken])
}

model LedgerEntry {
  id        String   @id @default(cuid())
  eventId   String
  ticketId  String?
  type      String   // ex. "RESERVATION_CASH_COLLECTION"
  amountCents Int
  agentId   String?
  createdAt DateTime @default(now())
  @@index([eventId, type])
}
```

Contrainte « 1 réservation active par compte » — voir l'index ci-dessous sur la table dédiée.

---

## 6 bis. Décision d'architecture : table `Reservation` dédiée (fait foi)

Le croquis §6 ci-dessus est idéalisé. **Décision retenue : une table `Reservation` dédiée**, distincte de `Ticket`/`Order`. Une réservation n'est **ni une commande ni un billet** : elle ne génère **pas** d'`Order` (aucun paiement en ligne) ni de `Ticket`. Elle possède son **propre `qrToken`** scanné à la porte et vit tout son cycle de vie dans cette seule table.

Avantages : la table porte nativement `eventId` + `userId`, donc l'index partiel « 1 par compte » est direct (pas de dénormalisation) ; les modèles `Ticket`/`Order`/`PaymentStatus`/`QRStatus` existants **ne sont pas touchés** ; le cash encaissé est tracé à part (hors ledger IOU).

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

  // Contact saisi dans le pop-up — stocké ICI, JAMAIS sur User (le porteur peut
  // différer du titulaire du compte → permet de faire la différence).
  holderFirstName   String
  holderLastName    String
  holderPhone       String

  paidAtGate        Boolean               @default(false)
  resolvedByAgentId String?               // agent ayant encaissé/supprimé (réconciliation)
  reservedAt        DateTime              @default(now())
  resolvedAt        DateTime?
  expiresAt         DateTime              // = event.endDate
  createdAt         DateTime              @default(now())

  @@index([eventId])
  @@index([qrToken])
  @@index([userId])
}
```

Index partiel « 1 réservation active par compte et par événement » (sur `Reservation`) :
```sql
CREATE UNIQUE INDEX one_active_reservation_per_user
  ON "Reservation" ("eventId", "userId")
  WHERE "status" = 'RESERVED';
```

Le plafond (50) reste porté par `TicketCategory.reservedCount` / `reservationCap` / `reservationEnabled` (décrément atomique inchangé). Le cash encaissé est tracé dans un modèle dédié `GateCashCollection` (hors `LedgerEntry`) : `{ eventId, reservationId @unique, amount, currency, agentId, createdAt }`.

## 6 ter. Cycle de vie — « seul le statut change »

Une réservation = **une seule ligne** `Reservation`. Encaisser / Supprimer **ne créent aucune nouvelle ligne** (ni billet, ni commande) : ils transitent **en place** le statut de cette même ligne (même `id`, même `qrToken`, QR mort après).

| Événement | `status` | `resolution` | `paidAtGate` | `resolvedAt` / `resolvedByAgentId` | `reservedCount` | Cash |
|---|---|---|---|---|---|---|
| Création (pop-up `Envoyer`) | `RESERVED` | `PENDING` | `false` | `null` | `+1` | — |
| **Encaisser** (agent) | `USED` | `COLLECTED` | `true` | `now()` / agent | **inchangé** | +prix → `GateCashCollection` |
| **Supprimer** (agent) | `CANCELLED` | `DELETED` | `false` | `now()` / agent | `−1` | — |

Le montant encaissé n'est **jamais** « dans » la ligne `Reservation` : il est écrit à part (`GateCashCollection`), source du compteur « Total encaissé ».

---

## 7. Logique critique

> **Lecture avec l'archi §6 bis :** dans cette section, « le `Ticket` » = **la ligne `Reservation`** (table dédiée), « `status` » = `Reservation.status` (`RESERVED`/`USED`/`CANCELLED`), et l'écriture financière « `LedgerEntry RESERVATION_CASH_COLLECTION` » = **`GateCashCollection`** (hors ledger IOU). La branche « billet payé » du scan reste sur le `Ticket` classique (inchangée).

### Création de réservation (atomique)
Dans une transaction :
1. `UPDATE "TicketCategory" SET "reservedCount" = "reservedCount" + 1
   WHERE id = :categoryId AND "reservationEnabled" = true
   AND "reservedCount" < "reservationCap"` → **retourne 0 ligne = plafond atteint** (rejet).
2. Créer le `Ticket` (`isReservation=true`, `status=RESERVED`, `resolution=PENDING`, contact, `qrToken` opaque).
   - L'index unique partiel garantit le « 1 par compte » (violation = déjà réservé → rejet).
3. Commit → émettre l'email/notif via l'outbox existant.

### Scan
`GET /scan/:qrToken` → selon le ticket :
- `status=USED` ou `CANCELLED` → **invalide** (déjà utilisé / annulé).
- `status=VALID` (payé) → **vert**, puis marquer `USED`.
- `status=RESERVED` → renvoyer `{ reserved: true, amountCents, holder }` → le frontend affiche le **pop-up jaune**.

### Encaisser (atomique)
Transaction :
1. Re-vérifier `status=RESERVED` (sinon rejet : déjà résolu).
2. `Ticket` → `status=USED`, `resolution=COLLECTED`, `paidAtGate=true`, `resolvedAt`, `resolvedByAgent`.
3. **`reservedCount` inchangé** (la réservation reste comptée parmi les 50).
4. Insérer `LedgerEntry` (`RESERVATION_CASH_COLLECTION`, `amountCents = category.priceCents`, `agentId`) → c'est ce qui fait monter le montant encaissé.
5. Commit → **QR mort**, accès accordé.

### Supprimer
Transaction : re-vérifier `RESERVED` → `status=CANCELLED`, `resolution=DELETED`, `resolvedByAgent` → `reservedCount -= 1` → **pas** de ledger. QR mort.

---

## 8. Plan d'implémentation (par phases)

- **Phase 0 — Schéma** : migration Prisma (enums, champs `Ticket`, champs `TicketCategory`, `LedgerEntry`, index unique partiel).
- **Phase 1 — Création de réservation** : service NestJS atomique (plafond 50, 1/compte, catégorie réservable uniquement) + validation DTO (nom/prénom/téléphone).
- **Phase 2 — Émission du billet réservé** : génération `qrToken`, apparition onglet Ticket + badge « Billet réservé », email via outbox.
- **Phase 3 — Endpoint de scan** : résolution par token, payload du pop-up (montant dû + contact).
- **Phase 4 — Actions agent** : `Encaisser` (ledger + admission + invalidation, atomique) et `Supprimer` (annulation + invalidation), horodatage + agentId.
- **Phase 5 — Dashboard** : 3 compteurs (réservations actives `X/50`, réservé-puis-payé, total encaissé).
- **Phase 6 — Frontend page event** : bouton `Acheter` (renommé) + bouton `Réserver`, logique de grisage (déjà réservé / 50 atteint), pop-up de saisie + disclaimer.
- **Phase 7 — Frontend scanner** : pop-up jaune, boutons `Encaisser` / `Supprimer` + **confirmation** sur Supprimer, feedback QR invalidé.
- **Phase 8 — Tests** : plafond atomique (pas de 51ᵉ en concurrence), 1 réservation/compte, QR réservé partagé → inutilisable après action, double-scan rejeté, cohérence ledger ↔ compteurs.

---

## 9. Points reportés (à garder en vue)
- **OTP SMS** du téléphone (nécessite un fournisseur SMS ; SendGrid ne couvre que l'email).
- **Cutoff d'expiration** des réservations non honorées (sinon les 50 places restent bloquées si personne ne vient).
