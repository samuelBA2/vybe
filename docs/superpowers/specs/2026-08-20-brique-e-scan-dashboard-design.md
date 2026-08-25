# Brique E — Dashboard de scans (organisateur)

**Date** : 2026-08-20
**Branche** : `feat/agent-creation-login-scanTicket`
**Statut** : spec validée, prêt pour le plan d'implémentation

## Objectif

Donner au créateur d'un événement une vue agrégée de l'affluence à l'entrée :
combien de billets vendus, combien scannés, la ventilation par catégorie et par
agent, et une courbe des scans dans le temps.

Côté front, cette vue s'ouvre quand l'utilisateur clique sur la carte d'un de ses
événements dans l'onglet « Mes Événements » (alimenté par `GET /events/mine`).
Chaque événement a ses propres statistiques.

## Portée (V1)

- Compteurs globaux + taux d'entrée.
- Ventilation par catégorie de billet.
- Ventilation par agent (activité de scan).
- Timeline des scans en buckets horaires (calculés côté serveur).

**Hors périmètre** (évolutions futures, YAGNI) :
- Temps réel (WebSocket/SSE) — la V1 est un snapshot rafraîchi par polling côté front.
- Granularité de bucket configurable (`?bucket=15m`) — fixée à l'heure en V1.
- Export CSV / PDF.

## Route & accès

- **`GET /events/:reference/scan-dashboard`**
- Déclarée dans `AgentController` (sans préfixe, chemins complets), juste à côté
  de `GET events/:reference/agents`.
- Gardes : `JwtAuthGuard, RolesGuard` + `@Roles('USER')`.
- Clé : `reference` (et non `id`), pour rester cohérent avec `listAgents`. La carte
  front dispose déjà de `reference` (renvoyé par `GET /events/mine`).
- **Propriété** : même pattern que `listAgents` —
  `prisma.event.findUnique({ where: { reference } })` ;
  `!event` ⇒ `NotFoundException` ; `event.createdById !== userId` ⇒ `ForbiddenException`.

## Rafraîchissement

Snapshot REST. Le `GET` renvoie l'état courant ; le front rappelle l'endpoint
périodiquement (ex. toutes les 10–15 s) pour une sensation « live ». Aucune infra
temps réel côté backend.

## Logique — `AgentService.getScanDashboard(userId, reference)`

Colocalisée avec `listAgents`/`scan` dans `AgentService` (même domaine, réutilise
la garde de propriété). Extraction dans un service dédié reportée si le service
grossit.

Après vérif de propriété (event trouvé + créateur), approche **hybride** :

1. **Statuts globaux** —
   `prisma.ticket.groupBy({ by: ['qrStatus'], where: { ticketCategory: { eventId } }, _count: true })`.
   Dérive :
   - `scanned` = count de `USED`
   - `unused` = count de `UNUSED`
   - `cancelled` = count de `CANCELLED`
   - `total` = `scanned + unused + cancelled`
   - `entryRate` = `scanned / (scanned + unused)` — **0 si le dénominateur est 0**
     (pas de division par zéro). Les `CANCELLED` sont exclus du dénominateur du
     taux d'entrée (un billet annulé n'est pas attendu à l'entrée). Renvoyé comme
     **fraction brute arrondie à 4 décimales** (ex. `0.6667`) ; le front formate en %.

2. **Par catégorie** —
   `prisma.ticketCategory.findMany({ where: { eventId }, select: { id, name, soldCount, totalStock } })`
   fusionné avec
   `prisma.ticket.groupBy({ by: ['ticketCategoryId'], where: { qrStatus: 'USED', ticketCategory: { eventId } }, _count: true })`.
   Pour chaque catégorie → `{ name, sold: soldCount, scanned, remaining: sold - scanned }`.

3. **Par agent** —
   `prisma.ticket.groupBy({ by: ['scannedByAgentId'], where: { qrStatus: 'USED', ticketCategory: { eventId } }, _count: true })`
   fusionné avec
   `prisma.agent.findMany({ where: { eventId }, select: { id, firstname, lastname } })`.
   Pour chaque agent ayant scanné → `{ agentId, name, scanned }`.
   `name` = `[firstname, lastname].filter(Boolean).join(' ').trim() || 'Agent inconnu'`
   (même logique de fallback que `scan`). Les billets `USED` sans
   `scannedByAgentId` (cas théorique) sont ignorés.

4. **Timeline** —
   `prisma.ticket.findMany({ where: { qrStatus: 'USED', ticketCategory: { eventId } }, select: { scannedAt: true } })`.
   Bucketing horaire en JS : pour chaque `scannedAt`, tronquer à l'heure via
   `new Date(d); d.setUTCMinutes(0, 0, 0)` (**UTC**, voir arbitrage ci-dessous), agréger
   par clé ISO dans une `Map`, puis produire `[{ hour: ISO, count }]` trié par `hour`
   croissant. `scannedAt` null (théorique pour un USED) ignoré.

   > **Arbitrage fuseau horaire (2026-08-24)** — la version initiale de cette spec
   > tronquait à l'heure **locale serveur** (`setMinutes`). L'implémentation retenue
   > tronque en **UTC** (`setUTCMinutes`) : résultat déterministe et testable
   > indépendamment du fuseau de la machine de déploiement (l'heure locale serveur
   > dépend du fuseau de l'hôte, ce qui est fragile en prod). Les `hour` renvoyés
   > sont donc des débuts d'heure **UTC** ; c'est au front de convertir en heure
   > locale à l'affichage.

## Forme de réponse — `src/agent/dto/ScanDashboard.dto.ts`

```ts
interface ScanDashboardResponseDto {
  event: { reference: string; title: string };
  totals: {
    total: number;
    scanned: number;
    unused: number;
    cancelled: number;
    entryRate: number; // fraction 0..1 arrondie à 4 décimales ; 0 si dénominateur nul
  };
  byCategory: { name: string; sold: number; scanned: number; remaining: number }[];
  byAgent: { agentId: string; name: string; scanned: number }[];
  timeline: { hour: string; count: number }[]; // hour = ISO début d'heure (UTC)
}
```

## Gestion des erreurs

- Event introuvable → `NotFoundException` (« Événement introuvable. »).
- Non-propriétaire → `ForbiddenException` (« Vous ne gérez pas cet événement. »).
- Aucun scan / aucun billet → tableaux vides, compteurs à 0, `entryRate` = 0.
  **Aucune erreur** dans ce cas.

## Tests — extension de `src/agent/agent.service.spec.ts`

Mock `PrismaService` (`event.findUnique`, `ticket.groupBy`, `ticketCategory.findMany`,
`agent.findMany`, `ticket.findMany`).

- Event inconnu ⇒ `NotFoundException`.
- Non-propriétaire (`createdById !== userId`) ⇒ `ForbiddenException`.
- Agrégats corrects : compteurs de statuts, `byCategory` (`remaining = sold - scanned`),
  `byAgent`, et `entryRate` cohérent.
- Timeline : deux scans dans la même heure ⇒ un bucket `count: 2` ; heures
  différentes ⇒ deux buckets triés croissant.
- Cas vide (0 scan) ⇒ tableaux vides, `entryRate = 0`, pas de division par zéro.

## Câblage

- Route ajoutée dans `AgentController` (import du DTO au besoin).
- Méthode ajoutée dans `AgentService`.
- DTO dans `src/agent/dto/ScanDashboard.dto.ts`.
- Aucune migration DB (tous les champs existent déjà : `qrStatus`, `scannedAt`,
  `scannedByAgentId`, `soldCount`, `totalStock`).

## Références

- Pattern de propriété : `AgentService.listAgents` (`src/agent/agent.service.ts`).
- Fallback de nom : `AgentService.scan` (`holderName`).
- Données front : `GET /events/mine` (`EventsService.findMine`).
