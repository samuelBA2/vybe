# Brique C (suite) — Rattrapage des visuels de billet

**Date :** 2026-08-19
**Statut :** Design validé, prêt pour plan d'implémentation

## Objectif

Auto-réparer les billets dont les visuels (`ticketImageUrl` / `pdfUrl`) sont
restés `null` — cas où la génération best-effort post-achat (brique D) a échoué
(panne Cloudinary, design temporairement inaccessible…). Le rattrapage se
déclenche **à la lecture** de `GET /me/tickets`, de façon **non-bloquante**, et
ne régénère **que les billets manquants** de l'utilisateur.

C'est la dernière pièce de la brique C.

## Portée

Inclus :
- Refactor `TicketAssetService` : extraction d'un helper privé partagé
  `generateForTickets(tickets)`.
- Nouvelle méthode `TicketAssetService.regenerateMissingForUser(userId)` avec
  garde-fou anti-concurrence en mémoire.
- Déclenchement non-bloquant depuis `MyTicketsService.getMyTickets`.
- Tests unitaires des deux services.

Hors périmètre (laissé pour plus tard) :
- Backoff / marquage des échecs **permanents** (un billet dont le design est
  définitivement cassé retentera une fois par lecture ; jamais deux en
  parallèle grâce au garde-fou).
- Rattrapage multi-instances (le garde-fou est mono-processus).
- Endpoint explicite de retry.

## Décisions de conception

1. **Déclenchement paresseux à la lecture, non-bloquant.** La réponse de
   `GET /me/tickets` n'attend jamais la régénération : les URLs manquantes
   restent `null` pour la requête courante et sont peuplées au prochain
   rafraîchissement. Cohérent avec le pattern best-effort de la brique D.
2. **Régénération ciblée sur les manquants.** On ne retouche pas les billets
   déjà bons (pas de réécriture d'URLs valides, pas d'upload Cloudinary inutile).
3. **Garde-fou en mémoire.** Un `Set<string>` d'`userId` en cours empêche deux
   rattrapages simultanés pour le même utilisateur (double-rafraîchissement).

## Modifications

### `TicketAssetService` (`src/ticket-asset/ticket-asset.service.ts`)

**Refactor — helper partagé.** Le cœur actuel de `generateAssetsForOrder`
(cache de promesses de design par catégorie + `Promise.allSettled` qui, pour
chaque billet, build PNG → upload → build PDF → upload → `ticket.update`) est
extrait tel quel dans :

```
private async generateForTickets(tickets): Promise<void>
```

où `tickets` est le résultat d'un `findMany` incluant
`ticketCategory: { include: { event: true } }`. La logique par billet et le
cache de design sont **inchangés** — simple déplacement.

**`generateAssetsForOrder(orderId)`** devient :

```
const tickets = await this.prisma.ticket.findMany({
  where: { orderId },
  include: { ticketCategory: { include: { event: true } } },
});
await this.generateForTickets(tickets);
```

Comportement identique à aujourd'hui (tous les billets de la commande).

**Nouvelle méthode `regenerateMissingForUser(userId)` :**

```
private inFlight = new Set<string>();

async regenerateMissingForUser(userId: string): Promise<void> {
  if (this.inFlight.has(userId)) return;      // garde-fou : déjà en vol
  this.inFlight.add(userId);
  try {
    const tickets = await this.prisma.ticket.findMany({
      where: {
        order: { userId },
        OR: [{ ticketImageUrl: null }, { pdfUrl: null }],
      },
      include: { ticketCategory: { include: { event: true } } },
    });
    if (tickets.length === 0) return;
    await this.generateForTickets(tickets);
  } catch (e) {
    // Best-effort : on log, on ne throw jamais (appelée en fire-and-forget).
    this.logger.error(
      `Rattrapage des visuels échoué (user ${userId}) : ${
        e instanceof Error ? e.stack : String(e)
      }`,
    );
  } finally {
    this.inFlight.delete(userId);
  }
}
```

Ne throw jamais. Le `finally` libère toujours le garde-fou, même en cas d'erreur.

### `MyTicketsService` (`src/orders/MyTickets.service.ts`)

- Injecter `TicketAssetService` dans le constructeur (déjà exporté par
  `TicketAssetModule`, déjà importé par `OrderModule`).
- Dans `getMyTickets`, après avoir construit `{ upcoming, past }` :

```
const result = { upcoming, past };

// Rattrapage best-effort, non-bloquant : si un visuel manque, on relance la
// génération en arrière-plan sans attendre (URLs peuplées au prochain chargement).
const hasMissing = [...upcoming, ...past].some((e) =>
  e.tickets.some((t) => t.ticketImageUrl === null || t.pdfUrl === null),
);
if (hasMissing) {
  void this.ticketAssets.regenerateMissingForUser(userId).catch(() => undefined);
}

return result;
```

La détection réutilise les billets déjà chargés (le `select` remonte
`ticketImageUrl` et `pdfUrl`) — aucune requête supplémentaire côté lecture.

### Module

`OrderModule` importe déjà `TicketAssetModule` et déclare `MyTicketsService` ;
aucune nouvelle plomberie. (À vérifier au moment de l'implémentation :
`TicketAssetModule` **exporte** bien `TicketAssetService` — c'est le cas puisque
`OrderService` l'injecte déjà.)

## Cas limites

- **Aucun billet manquant** → `hasMissing` faux → aucun appel de rattrapage.
- **Rattrapage déjà en vol** pour l'utilisateur → 2ᵉ déclenchement ignoré par le
  garde-fou (aucun `findMany`, aucune régénération).
- **Rattrapage qui échoue** (DB, Cloudinary…) → loggé, jamais propagé ; la
  réponse de `GET /me/tickets` n'est pas affectée.
- **Échec permanent d'un billet** → une tentative par lecture (accepté, hors
  périmètre).

## Tests

### `TicketAssetService` (`ticket-asset.service.spec.ts`)

- `regenerateMissingForUser` interroge **uniquement les manquants** : assertion
  que `findMany` reçoit `where: { order: { userId }, OR: [{ ticketImageUrl: null },
  { pdfUrl: null }] }`, puis régénère et `update` chaque billet renvoyé (mêmes
  mocks `cloudinary` + spies `buildTicketImage`/`buildTicketPdf` que les tests
  existants de `generateAssetsForOrder`).
- **Garde-fou** : pendant qu'un premier appel est en vol (`findMany` sur une
  promesse non résolue manuellement), un second appel pour le même `userId`
  retourne sans déclencher un 2ᵉ `findMany`.
- Aucun manquant (`findMany` renvoie `[]`) → n'appelle pas la génération, ne
  throw pas.

### `MyTicketsService` (`MyTickets.service.spec.ts`)

- Injecter un `TicketAssetService` mocké
  (`{ regenerateMissingForUser: jest.fn().mockResolvedValue(undefined) }`). Le
  `beforeEach` existant du spec passe aujourd'hui `new MyTicketsService(prisma)` :
  il faut le mettre à jour pour passer ce 2ᵉ argument mocké.
- Déclenche `regenerateMissingForUser('user-1')` quand un billet a
  `ticketImageUrl` ou `pdfUrl` à `null`.
- **Ne déclenche pas** quand tous les visuels sont présents.
- Non-bloquant : la réponse est renvoyée normalement même si
  `regenerateMissingForUser` rejette (un rejet ne casse pas la lecture).
