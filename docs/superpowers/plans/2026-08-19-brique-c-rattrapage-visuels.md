# Brique C (suite) — Rattrapage des visuels : Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-réparer les billets aux visuels `null` en régénérant, à la lecture de `GET /me/tickets`, uniquement les billets manquants de l'utilisateur — de façon non-bloquante.

**Architecture:** Refactor de `TicketAssetService` pour extraire un helper partagé `generateForTickets`, puis une nouvelle méthode `regenerateMissingForUser(userId)` (ciblée sur les manquants, avec garde-fou anti-concurrence en mémoire). `MyTicketsService.getMyTickets` déclenche cette méthode en fire-and-forget quand un visuel manque.

**Tech Stack:** NestJS, TypeScript, Prisma, Jest.

## Global Constraints

- Commentaires et messages en **français**.
- Imports absolus `src/...`.
- Enums/type Prisma via `import { Prisma, QRStatus } from '@prisma/client'`.
- Pas de `Co-Authored-By` dans les commits.
- Best-effort : le rattrapage ne throw **jamais** et ne bloque jamais la lecture.
- Tests service : instancier le service réel avec des dépendances mockées (style du repo, pas de `TestingModule` pour les services).

---

## File Structure

- `src/ticket-asset/ticket-asset.service.ts` (modifié) — extraction `generateForTickets`, ajout `regenerateMissingForUser` + `inFlight`.
- `src/ticket-asset/ticket-asset.service.spec.ts` (modifié) — tests de `regenerateMissingForUser` + garde-fou.
- `src/orders/MyTickets.service.ts` (modifié) — injection `TicketAssetService`, déclenchement fire-and-forget.
- `src/orders/MyTickets.service.spec.ts` (modifié) — mock `TicketAssetService`, tests du déclenchement.

Aucun changement de module (`OrderModule` importe déjà `TicketAssetModule` qui exporte `TicketAssetService`).

---

## Task 1: Refactor — extraire `generateForTickets`

Refactor pur, couvert par les tests existants de `generateAssetsForOrder` (aucun changement de comportement).

**Files:**
- Modify: `src/ticket-asset/ticket-asset.service.ts`

**Interfaces:**
- Consumes: rien de nouveau.
- Produces: `private generateForTickets(tickets: TicketWithEvent[]): Promise<void>` ; `generateAssetsForOrder` inchangé côté signature/comportement.

- [ ] **Step 1: Vérifier que les tests existants passent (point de départ vert)**

Run: `npx jest src/ticket-asset/ticket-asset.service.spec.ts`
Expected: PASS (tests actuels dont `generateAssetsForOrder`).

- [ ] **Step 2: Ajouter le type de payload et remplacer `generateAssetsForOrder`**

En haut du fichier, compléter l'import Prisma :

```typescript
import { Prisma } from '@prisma/client';
```

Juste au-dessus du décorateur `@Injectable()` (à côté de `TicketFields`), ajouter le type partagé :

```typescript
// Billet avec sa catégorie et son événement, tel que chargé pour la génération.
type TicketWithEvent = Prisma.TicketGetPayload<{
    include: { ticketCategory: { include: { event: true } } };
}>;
```

Remplacer entièrement la méthode `generateAssetsForOrder` par les **deux** méthodes suivantes (la 2ᵉ contient le cœur inchangé : cache de design + `Promise.allSettled`) :

```typescript
        // Post-commit best-effort : génère PNG+PDF de chaque billet de la commande.
        async generateAssetsForOrder(orderId: string): Promise<void> {
            const tickets = await this.prisma.ticket.findMany({
                where: { orderId },
                include: { ticketCategory: { include: { event: true } } },
            });
            await this.generateForTickets(tickets);
        }

        // Cœur partagé : pour chaque billet, build PNG → upload → build PDF → upload → update.
        // Best-effort par billet (un échec n'empêche pas les autres, ne throw pas).
        private async generateForTickets(tickets: TicketWithEvent[]): Promise<void> {
            // Cache de PROMESSES par catégorie : un seul fetch même en parallèle.
            const designCache = new Map<string, Promise<Buffer>>();
            const getDesign = (categoryId: string, url: string): Promise<Buffer> => {
                let p = designCache.get(categoryId);
                if (!p) {
                    p = this.fetchDesign(url);
                    designCache.set(categoryId, p);
                }
                return p;
            };
            await Promise.allSettled(
                tickets.map(async (t) => {
                    try {
                        const ev = t.ticketCategory.event;
                        const design = await getDesign(t.ticketCategoryId, t.ticketCategory.ticketDesignUrl);
                        const png = await this.buildTicketImage(design, {
                            qrToken: t.qrToken,
                            eventCategory: ev.category,
                            eventTitle: ev.title,
                            dateLabel: this.dateLabel(ev.startDate),
                            timeLabel: this.timeLabel(ev.startDate),
                            placeLabel: t.ticketCategory.name,
                        });
                        const imageRes = await this.cloudinary.uploadBuffer(png, CloudinaryFolder.TICKETS);
                        const pdf = await this.buildTicketPdf(png);
                        const pdfRes = await this.cloudinary.uploadRawBuffer(pdf, CloudinaryFolder.TICKETS, `ticket-${t.id}`);
                        await this.prisma.ticket.update({
                            where: { id: t.id },
                            data: { ticketImageUrl: imageRes.secure_url, pdfUrl: pdfRes.secure_url },
                        });
                    } catch (e) {
                        this.logger.error(
                            `Echec génération des visuels du billet ${t.id} : ${e instanceof Error ? e.stack : String(e)}`,
                        );
                    }
                }),
            );
        }
```

- [ ] **Step 3: Rejouer les tests existants (comportement conservé)**

Run: `npx jest src/ticket-asset/ticket-asset.service.spec.ts`
Expected: PASS (identique au Step 1 — le refactor n'a rien changé).

- [ ] **Step 4: Commit**

```bash
git add src/ticket-asset/ticket-asset.service.ts
git commit -m "refactor(tickets): extrait generateForTickets partagé (brique C)"
```

---

## Task 2: `regenerateMissingForUser` + garde-fou

**Files:**
- Modify: `src/ticket-asset/ticket-asset.service.ts`
- Test: `src/ticket-asset/ticket-asset.service.spec.ts`

**Interfaces:**
- Consumes: `generateForTickets` (Task 1), `prisma.ticket.findMany`.
- Produces: `regenerateMissingForUser(userId: string): Promise<void>` — best-effort, ne throw jamais.

- [ ] **Step 1: Écrire les tests (qui échouent)**

Dans `src/ticket-asset/ticket-asset.service.spec.ts`, ajouter un nouveau bloc `describe` (à l'intérieur du `describe` racine, à côté de celui de `generateAssetsForOrder`) :

```typescript
describe('TicketAssetService.regenerateMissingForUser', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const evt = { category: 'FESTIVAL', title: 'Neon Nights', startDate: new Date('2026-06-27T22:00:00') };
  const missing = {
    id: 't1', qrToken: 'q1', ticketCategoryId: 'c1',
    ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png', event: evt },
  };

  function buildService(findManyImpl: jest.Mock) {
    const prisma = { ticket: { findMany: findManyImpl, update: jest.fn().mockResolvedValue({}) } } as any;
    const cloudinary = {
      uploadBuffer: jest.fn().mockResolvedValue({ secure_url: 'https://cdn/img.png' }),
      uploadRawBuffer: jest.fn().mockResolvedValue({ secure_url: 'https://cdn/doc.pdf' }),
    } as any;
    const service = new TicketAssetService(prisma, cloudinary);
    jest.spyOn(service, 'buildTicketImage').mockResolvedValue(Buffer.from('PNG'));
    jest.spyOn(service, 'buildTicketPdf').mockResolvedValue(Buffer.from('%PDF'));
    return { service, prisma };
  }

  it('ne charge que les billets aux URLs manquantes et les régénère', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as any;
    const findMany = jest.fn().mockResolvedValue([missing]);
    const { service, prisma } = buildService(findMany);

    await service.regenerateMissingForUser('user-1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { order: { userId: 'user-1' }, OR: [{ ticketImageUrl: null }, { pdfUrl: null }] },
      }),
    );
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { ticketImageUrl: 'https://cdn/img.png', pdfUrl: 'https://cdn/doc.pdf' },
    });
  });

  it('aucun manquant → pas de génération, ne throw pas', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service, prisma } = buildService(findMany);
    await expect(service.regenerateMissingForUser('user-1')).resolves.toBeUndefined();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('garde-fou : un 2ᵉ appel concurrent pour le même user ne relance pas findMany', async () => {
    let resolveFind: (v: any) => void;
    const findMany = jest.fn().mockReturnValueOnce(new Promise((r) => { resolveFind = r; }));
    const { service } = buildService(findMany);

    const p1 = service.regenerateMissingForUser('user-1'); // en vol, bloqué sur findMany
    await service.regenerateMissingForUser('user-1');       // sauté par le garde-fou

    expect(findMany).toHaveBeenCalledTimes(1);
    resolveFind!([]);
    await p1;
  });
});
```

- [ ] **Step 2: Lancer les tests → ils échouent**

Run: `npx jest src/ticket-asset/ticket-asset.service.spec.ts -t regenerateMissingForUser`
Expected: FAIL — `service.regenerateMissingForUser is not a function`.

- [ ] **Step 3: Implémenter la méthode + le garde-fou**

Dans la classe `TicketAssetService`, ajouter le champ `inFlight` près du `logger` :

```typescript
        // userId dont un rattrapage est déjà en cours (anti double-régénération).
        private readonly inFlight = new Set<string>();
```

Et ajouter la méthode (par exemple juste après `generateForTickets`) :

```typescript
        // Rattrapage best-effort : régénère uniquement les billets de l'utilisateur
        // dont un visuel manque. Non-bloquant côté appelant ; ne throw jamais.
        async regenerateMissingForUser(userId: string): Promise<void> {
            if (this.inFlight.has(userId)) return; // déjà en vol pour cet utilisateur
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
                this.logger.error(
                    `Rattrapage des visuels échoué (user ${userId}) : ${e instanceof Error ? e.stack : String(e)}`,
                );
            } finally {
                this.inFlight.delete(userId);
            }
        }
```

- [ ] **Step 4: Lancer les tests → ils passent**

Run: `npx jest src/ticket-asset/ticket-asset.service.spec.ts`
Expected: PASS (anciens + 3 nouveaux).

- [ ] **Step 5: Commit**

```bash
git add src/ticket-asset/ticket-asset.service.ts src/ticket-asset/ticket-asset.service.spec.ts
git commit -m "feat(tickets): regenerateMissingForUser + garde-fou (brique C)"
```

---

## Task 3: Déclenchement non-bloquant dans `MyTicketsService`

**Files:**
- Modify: `src/orders/MyTickets.service.ts`
- Test: `src/orders/MyTickets.service.spec.ts`

**Interfaces:**
- Consumes: `TicketAssetService.regenerateMissingForUser` (Task 2).
- Produces: `getMyTickets` déclenche le rattrapage en fire-and-forget quand un visuel manque.

- [ ] **Step 1: Mettre à jour les tests (mock + 3 nouveaux)**

Dans `src/orders/MyTickets.service.spec.ts`, modifier le `beforeEach` pour injecter un `TicketAssetService` mocké et l'exposer aux tests :

```typescript
  let ticketAssets: { regenerateMissingForUser: jest.Mock };

  beforeEach(() => {
    prisma = { ticket: { findMany: jest.fn().mockResolvedValue([]) } };
    ticketAssets = { regenerateMissingForUser: jest.fn().mockResolvedValue(undefined) };
    service = new MyTicketsService(
      prisma as unknown as PrismaService,
      ticketAssets as any,
    );
  });
```

Ajouter, à la fin du `describe`, un sous-bloc pour le rattrapage :

```typescript
  describe('rattrapage des visuels', () => {
    it('déclenche regenerateMissingForUser quand un billet a une URL null', async () => {
      scopedRows([row({ id: 't1', ticketImageUrl: null })]);
      await service.getMyTickets('user-1');
      expect(ticketAssets.regenerateMissingForUser).toHaveBeenCalledWith('user-1');
    });

    it('ne déclenche rien quand tous les visuels sont présents', async () => {
      scopedRows([row({ id: 't1' })]); // urls par défaut = 'png-url' / 'pdf-url'
      await service.getMyTickets('user-1');
      expect(ticketAssets.regenerateMissingForUser).not.toHaveBeenCalled();
    });

    it('non-bloquant : un rejet du rattrapage ne casse pas la lecture', async () => {
      scopedRows([row({ id: 't1', pdfUrl: null })]);
      ticketAssets.regenerateMissingForUser.mockRejectedValue(new Error('KO'));
      await expect(service.getMyTickets('user-1')).resolves.toBeDefined();
    });
  });
```

- [ ] **Step 2: Lancer les tests → ils échouent**

Run: `npx jest src/orders/MyTickets.service.spec.ts`
Expected: FAIL — l'ancien constructeur ne prend qu'un argument / `regenerateMissingForUser` jamais appelé.

- [ ] **Step 3: Injecter le service et déclencher le rattrapage**

Dans `src/orders/MyTickets.service.ts`, ajouter l'import :

```typescript
import { TicketAssetService } from 'src/ticket-asset/ticket-asset.service';
```

Modifier le constructeur pour injecter le service :

```typescript
    constructor(
        private readonly prisma: PrismaService,
        private readonly ticketAssets: TicketAssetService,
    ) {}
```

Remplacer le corps de `getMyTickets` par :

```typescript
    async getMyTickets(userId: string): Promise<MyTicketsResponseDto> {
        const now = new Date();
        const [upcoming, past] = await Promise.all([
            this.getScope(userId, now, 'upcoming'),
            this.getScope(userId, now, 'past'),
        ]);
        const result = { upcoming, past };

        // Rattrapage best-effort non-bloquant : si un visuel manque, on relance la
        // génération en arrière-plan sans attendre (URLs peuplées au prochain chargement).
        const hasMissing = [...upcoming, ...past].some((e) =>
            e.tickets.some((t) => t.ticketImageUrl === null || t.pdfUrl === null),
        );
        if (hasMissing) {
            void this.ticketAssets
                .regenerateMissingForUser(userId)
                .catch(() => undefined);
        }

        return result;
    }
```

- [ ] **Step 4: Lancer les tests → ils passent**

Run: `npx jest src/orders/MyTickets.service.spec.ts`
Expected: PASS (anciens + 3 nouveaux).

- [ ] **Step 5: Suite complète + build**

Run: `npm test && npm run build`
Expected: suite verte, build sans erreur TypeScript.

- [ ] **Step 6: Commit**

```bash
git add src/orders/MyTickets.service.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(tickets): rattrapage des visuels à la lecture de /me/tickets (brique C)"
```

---

## Notes de vérification manuelle (optionnel)

1. Créer une commande, forcer un billet à `ticketImageUrl = null` en base.
2. `GET /me/tickets` → réponse immédiate (URL encore `null`), et dans les logs la régénération se lance.
3. `GET /me/tickets` à nouveau après quelques secondes → l'URL est peuplée.
4. Deux `GET` rapprochés → un seul rattrapage effectif (garde-fou).
