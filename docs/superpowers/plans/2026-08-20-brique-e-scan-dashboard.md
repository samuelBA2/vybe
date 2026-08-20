# Dashboard de scans (Brique E) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exposer `GET /events/:reference/scan-dashboard`, une vue agrégée (totaux, par catégorie, par agent, timeline horaire) réservée au créateur de l'événement.

**Architecture:** Une méthode `AgentService.getScanDashboard(userId, reference)` réutilise la garde de propriété de `listAgents`, puis agrège via `groupBy` Prisma (statuts, catégories, agents) et un `findMany` léger des `scannedAt` (billets USED) pour le bucketing horaire en JS. La route est ajoutée à `AgentController` à côté de `listAgents`.

**Tech Stack:** NestJS, Prisma (Postgres), Jest.

## Global Constraints

- Commentaires et messages d'erreur en **français**.
- Pas de `Co-Authored-By` dans les messages de commit.
- Aucune migration DB : tous les champs utilisés existent déjà (`qrStatus`, `scannedAt`, `scannedByAgentId`, `soldCount`, `totalStock`, `Event.title`).
- Propriété vérifiée comme `listAgents` : `event` introuvable ⇒ `NotFoundException('Événement introuvable.')` ; `createdById !== userId` ⇒ `ForbiddenException('Vous ne gérez pas cet événement.')`.
- `entryRate` = fraction brute arrondie à 4 décimales, `0` si dénominateur nul ; `CANCELLED` exclus du dénominateur.

---

## File Structure

- **Create** `src/agent/dto/ScanDashboard.dto.ts` — interface de réponse du dashboard.
- **Modify** `src/agent/agent.service.ts` — ajoute `getScanDashboard`.
- **Modify** `src/agent/agent.service.spec.ts` — étend le mock Prisma + tests du dashboard.
- **Modify** `src/agent/agent.controller.ts` — ajoute la route `GET events/:reference/scan-dashboard`.

---

## Task 1 : DTO + `getScanDashboard` (service, TDD)

**Files:**
- Create: `src/agent/dto/ScanDashboard.dto.ts`
- Modify: `src/agent/agent.service.ts` (nouvelle méthode en fin de classe, avant les helpers privés)
- Test: `src/agent/agent.service.spec.ts`

**Interfaces:**
- Produces: `AgentService.getScanDashboard(userId: string, reference: string): Promise<ScanDashboardResponseDto>`
- Produces (`ScanDashboard.dto.ts`):
  ```ts
  interface ScanDashboardResponseDto {
    event: { reference: string; title: string };
    totals: { total: number; scanned: number; unused: number; cancelled: number; entryRate: number };
    byCategory: { name: string; sold: number; scanned: number; remaining: number }[];
    byAgent: { agentId: string; name: string; scanned: number }[];
    timeline: { hour: string; count: number }[];
  }
  ```

- [ ] **Step 1: Créer le DTO**

Create `src/agent/dto/ScanDashboard.dto.ts` :

```ts
// Réponse agrégée du dashboard de scans d'un événement (brique E).
export interface ScanDashboardResponseDto {
  event: { reference: string; title: string };
  totals: {
    total: number;
    scanned: number; // billets USED
    unused: number; // billets UNUSED
    cancelled: number; // billets CANCELLED
    entryRate: number; // scanned / (scanned + unused), fraction 0..1 à 4 décimales, 0 si nul
  };
  byCategory: { name: string; sold: number; scanned: number; remaining: number }[];
  byAgent: { agentId: string; name: string; scanned: number }[];
  timeline: { hour: string; count: number }[]; // hour = ISO du début d'heure
}
```

- [ ] **Step 2: Étendre le mock Prisma du spec**

In `src/agent/agent.service.spec.ts`, dans la déclaration de type `let prisma: {...}` et l'objet `prisma = {...}` du `beforeEach`, ajouter `groupBy` à `ticket` et un modèle `ticketCategory`.

Remplacer le bloc type :

```ts
  let prisma: {
    event: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock; create: jest.Mock; findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    ticket: { findUnique: jest.Mock; updateMany: jest.Mock };
  };
```

par :

```ts
  let prisma: {
    event: { findUnique: jest.Mock };
    agent: { findUnique: jest.Mock; create: jest.Mock; findMany: jest.Mock; update: jest.Mock; count: jest.Mock };
    ticket: { findUnique: jest.Mock; updateMany: jest.Mock; groupBy: jest.Mock; findMany: jest.Mock };
    ticketCategory: { findMany: jest.Mock };
  };
```

et l'objet du `beforeEach` :

```ts
    prisma = {
      event: { findUnique: jest.fn() },
      agent: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      ticket: { findUnique: jest.fn(), updateMany: jest.fn(), groupBy: jest.fn(), findMany: jest.fn() },
      ticketCategory: { findMany: jest.fn() },
    };
```

- [ ] **Step 3: Écrire les tests qui échouent**

In `src/agent/agent.service.spec.ts`, ajouter en fin de fichier (avant le dernier `});` fermant `describe('AgentService', ...)`) :

```ts
  // ─── getScanDashboard ─────────────────────────────────────────────────────────
  describe('getScanDashboard', () => {
    it('événement introuvable → 404, aucune agrégation', async () => {
      prisma.event.findUnique.mockResolvedValue(null);
      await expect(service.getScanDashboard('user-1', 'VYBE-8JGBLV')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.ticket.groupBy).not.toHaveBeenCalled();
    });

    it('non-propriétaire → 403, aucune agrégation', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'e1', reference: 'VYBE-8JGBLV', title: 'Fête', createdById: 'owner' });
      await expect(service.getScanDashboard('intrus', 'VYBE-8JGBLV')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.ticket.groupBy).not.toHaveBeenCalled();
    });

    it('agrège totaux, catégories, agents et taux d\'entrée', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'e1', reference: 'VYBE-8JGBLV', title: 'Fête', createdById: 'owner' });
      // statuts globaux
      prisma.ticket.groupBy
        .mockResolvedValueOnce([
          { qrStatus: 'USED', _count: 3 },
          { qrStatus: 'UNUSED', _count: 1 },
          { qrStatus: 'CANCELLED', _count: 2 },
        ])
        // USED par catégorie
        .mockResolvedValueOnce([{ ticketCategoryId: 'c1', _count: 2 }, { ticketCategoryId: 'c2', _count: 1 }])
        // USED par agent
        .mockResolvedValueOnce([{ scannedByAgentId: 'a1', _count: 3 }]);
      prisma.ticketCategory.findMany.mockResolvedValue([
        { id: 'c1', name: 'VIP', soldCount: 5, totalStock: 10 },
        { id: 'c2', name: 'Standard', soldCount: 4, totalStock: null },
      ]);
      prisma.agent.findMany.mockResolvedValue([{ id: 'a1', firstname: 'Ada', lastname: 'Lovelace' }]);
      prisma.ticket.findMany.mockResolvedValue([]); // timeline vide ici

      const res = await service.getScanDashboard('owner', 'VYBE-8JGBLV');

      expect(res.event).toEqual({ reference: 'VYBE-8JGBLV', title: 'Fête' });
      expect(res.totals).toEqual({
        total: 6,
        scanned: 3,
        unused: 1,
        cancelled: 2,
        entryRate: 0.75, // 3 / (3 + 1)
      });
      expect(res.byCategory).toEqual([
        { name: 'VIP', sold: 5, scanned: 2, remaining: 3 },
        { name: 'Standard', sold: 4, scanned: 1, remaining: 3 },
      ]);
      expect(res.byAgent).toEqual([{ agentId: 'a1', name: 'Ada Lovelace', scanned: 3 }]);
    });

    it('cas vide (0 scan) → tableaux vides, entryRate 0 sans division par zéro', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'e1', reference: 'VYBE-8JGBLV', title: 'Fête', createdById: 'owner' });
      prisma.ticket.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      prisma.ticketCategory.findMany.mockResolvedValue([]);
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.ticket.findMany.mockResolvedValue([]);

      const res = await service.getScanDashboard('owner', 'VYBE-8JGBLV');

      expect(res.totals).toEqual({ total: 0, scanned: 0, unused: 0, cancelled: 0, entryRate: 0 });
      expect(res.byCategory).toEqual([]);
      expect(res.byAgent).toEqual([]);
      expect(res.timeline).toEqual([]);
    });

    it('timeline : deux scans même heure → un bucket count 2 ; heures différentes → deux buckets triés', async () => {
      prisma.event.findUnique.mockResolvedValue({ id: 'e1', reference: 'VYBE-8JGBLV', title: 'Fête', createdById: 'owner' });
      prisma.ticket.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      prisma.ticketCategory.findMany.mockResolvedValue([]);
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.ticket.findMany.mockResolvedValue([
        { scannedAt: new Date('2026-08-20T18:05:00.000Z') },
        { scannedAt: new Date('2026-08-20T18:52:00.000Z') },
        { scannedAt: new Date('2026-08-20T20:10:00.000Z') },
      ]);

      const res = await service.getScanDashboard('owner', 'VYBE-8JGBLV');

      expect(res.timeline).toEqual([
        { hour: '2026-08-20T18:00:00.000Z', count: 2 },
        { hour: '2026-08-20T20:00:00.000Z', count: 1 },
      ]);
    });
  });
```

> Note : le test de timeline attend une troncature horaire **en UTC** (clés `...T18:00:00.000Z`). L'implémentation (Step 5) utilise `setUTCMinutes(0,0,0)` pour un résultat déterministe quel que soit le fuseau de la machine de test.

- [ ] **Step 4: Lancer les tests → échec attendu**

Run: `npx jest src/agent/agent.service.spec.ts -t "getScanDashboard"`
Expected: FAIL — `service.getScanDashboard is not a function`.

- [ ] **Step 5: Implémenter `getScanDashboard`**

In `src/agent/agent.service.ts`, ajouter l'import du DTO en tête :

```ts
import { ScanDashboardResponseDto } from './dto/ScanDashboard.dto';
```

Puis ajouter la méthode dans la classe `AgentService`, après `scan(...)` et avant les helpers privés (`generateUniqueCode`) :

```ts
  // Dashboard de scans réservé au créateur de l'événement (brique E).
  // Agrégation hybride : groupBy pour statuts/catégories/agents,
  // findMany léger des scannedAt (USED) pour la timeline horaire en JS.
  async getScanDashboard(userId: string, reference: string): Promise<ScanDashboardResponseDto> {
    const event = await this.prisma.event.findUnique({ where: { reference } });
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.createdById !== userId) throw new ForbiddenException('Vous ne gérez pas cet événement.');

    const eventId = event.id;
    const eventFilter = { ticketCategory: { eventId } };

    // 1. Statuts globaux
    const statusGroups = await this.prisma.ticket.groupBy({
      by: ['qrStatus'],
      where: eventFilter,
      _count: true,
    });
    const countByStatus = (s: string): number =>
      statusGroups.find((g: any) => g.qrStatus === s)?._count ?? 0;
    const scanned = countByStatus('USED');
    const unused = countByStatus('UNUSED');
    const cancelled = countByStatus('CANCELLED');
    const total = scanned + unused + cancelled;
    const attended = scanned + unused;
    const entryRate = attended === 0 ? 0 : Math.round((scanned / attended) * 10000) / 10000;

    // 2. Par catégorie
    const categories = await this.prisma.ticketCategory.findMany({
      where: { eventId },
      select: { id: true, name: true, soldCount: true, totalStock: true },
    });
    const usedByCategory = await this.prisma.ticket.groupBy({
      by: ['ticketCategoryId'],
      where: { qrStatus: 'USED', ...eventFilter },
      _count: true,
    });
    const scannedForCat = (id: string): number =>
      usedByCategory.find((g: any) => g.ticketCategoryId === id)?._count ?? 0;
    const byCategory = categories.map((c) => {
      const catScanned = scannedForCat(c.id);
      return { name: c.name, sold: c.soldCount, scanned: catScanned, remaining: c.soldCount - catScanned };
    });

    // 3. Par agent
    const usedByAgent = await this.prisma.ticket.groupBy({
      by: ['scannedByAgentId'],
      where: { qrStatus: 'USED', ...eventFilter },
      _count: true,
    });
    const agents = await this.prisma.agent.findMany({
      where: { eventId },
      select: { id: true, firstname: true, lastname: true },
    });
    const agentName = (a: { firstname: string | null; lastname: string | null }): string =>
      [a.firstname, a.lastname].filter(Boolean).join(' ').trim() || 'Agent inconnu';
    const byAgent = usedByAgent
      .filter((g: any) => g.scannedByAgentId != null)
      .map((g: any) => {
        const agent = agents.find((a) => a.id === g.scannedByAgentId);
        return {
          agentId: g.scannedByAgentId as string,
          name: agent ? agentName(agent) : 'Agent inconnu',
          scanned: g._count as number,
        };
      });

    // 4. Timeline (buckets horaires, troncature en UTC pour un résultat déterministe)
    const usedTickets = await this.prisma.ticket.findMany({
      where: { qrStatus: 'USED', ...eventFilter },
      select: { scannedAt: true },
    });
    const buckets = new Map<string, number>();
    for (const t of usedTickets) {
      if (!t.scannedAt) continue;
      const d = new Date(t.scannedAt);
      d.setUTCMinutes(0, 0, 0);
      const key = d.toISOString();
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const timeline = [...buckets.entries()]
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => a.hour.localeCompare(b.hour));

    return {
      event: { reference: event.reference, title: event.title },
      totals: { total, scanned, unused, cancelled, entryRate },
      byCategory,
      byAgent,
      timeline,
    };
  }
```

- [ ] **Step 6: Lancer les tests → succès attendu**

Run: `npx jest src/agent/agent.service.spec.ts -t "getScanDashboard"`
Expected: PASS (5 tests verts).

- [ ] **Step 7: Commit**

```bash
git add src/agent/dto/ScanDashboard.dto.ts src/agent/agent.service.ts src/agent/agent.service.spec.ts
git commit -m "feat(scan): getScanDashboard — agrégats de scans par event (brique E)"
```

---

## Task 2 : Route `GET events/:reference/scan-dashboard` + vérification build

**Files:**
- Modify: `src/agent/agent.controller.ts`

**Interfaces:**
- Consumes: `AgentService.getScanDashboard(userId, reference)` (Task 1).

- [ ] **Step 1: Ajouter la route dans `AgentController`**

In `src/agent/agent.controller.ts`, après la méthode `list` (`@Get('events/:reference/agents')`), ajouter :

```ts
   // Dashboard de scans d'un événement (organisateur uniquement, propriété
   // vérifiée dans le service).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Get('events/:reference/scan-dashboard')
  async scanDashboard(@Req() req, @Param('reference') reference: string) {
    return this.agentService.getScanDashboard(req.user.sub, reference);
  }
```

- [ ] **Step 2: Vérifier le build**

Run: `npm run build`
Expected: build OK, aucune erreur TypeScript.

- [ ] **Step 3: Lancer toute la suite**

Run: `npm test`
Expected: PASS — suite verte (les tests existants + les 5 nouveaux).

- [ ] **Step 4: Commit**

```bash
git add src/agent/agent.controller.ts
git commit -m "feat(scan): route GET /events/:reference/scan-dashboard (brique E)"
```

---

## Self-Review (fait pendant la rédaction)

- **Couverture spec** : route + accès (Task 2), garde de propriété (Task 1 Step 5 + tests), 4 agrégats (Task 1 Step 5), forme de réponse (DTO Step 1), erreurs (tests 404/403 + cas vide), tests étendant `agent.service.spec.ts` — tous couverts.
- **Placeholders** : aucun ; tout le code est fourni.
- **Cohérence des types** : `getScanDashboard(userId, reference)` et `ScanDashboardResponseDto` identiques entre DTO, service, tests et controller. `entryRate` = fraction 4 décimales, `0` si nul, aligné spec. `_count` traité comme `number` (forme `_count: true` de Prisma groupBy).

## Note de fuseau horaire

La spec dit « heure locale serveur » ; l'implémentation tronque en **UTC** (`setUTCMinutes`) pour un résultat déterministe et testable indépendamment du fuseau de la machine. Écart volontaire vs. spec, assumé ici (à re-préciser dans la spec si le front attend l'heure locale). À signaler à l'utilisateur au démarrage de l'implémentation.
