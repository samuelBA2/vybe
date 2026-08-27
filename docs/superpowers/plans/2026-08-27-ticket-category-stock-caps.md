# Bornage des catégories de billets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** À la création d'événement, borner les catégories de billets — la 1re catégorie (base) peut être illimitée ou plafonnée à 50 000 ; toute autre (spéciale) doit déclarer un plafond fini ≤ 150 — avec blocage backend, formulaire front cohérent, et KPI dashboard aligné.

**Architecture:** Règle métier appliquée dans `EventsService.createEvent` (backend NestJS, source de vérité, blocage `BadRequestException`). Le formulaire front (`CreateEvent.tsx` + `createEvent.payload.ts`) est mis en cohérence pour ne jamais produire un payload rejeté. Le KPI capacité du scan-dashboard lit désormais `event.totalCapacity`.

**Tech Stack:** Backend : NestJS + Prisma + Jest (`/Users/user/vybe`). Frontend : React + Vite + Vitest + react-hook-form/zod (`/Users/user/vybeFrontend`).

## Global Constraints

- **Identification positionnelle** : `ticketCategories[0]` = **base** ; `ticketCategories[i]` pour `i ≥ 1` = **spéciale**. Aucun champ `tier` ajouté au schéma.
- **Base (index 0)** : la SEULE autorisée à être illimitée (`totalStock = null`, uniquement quand `unlimitedStock === true`). Sinon plafond fini `1 ≤ x ≤ MAX_TOTAL_CAPACITY` (= 50000).
- **Spéciales (index ≥ 1)** : `totalStock` **obligatoire, fini, `1 ≤ x ≤ MAX_SPECIAL_STOCK` (= 150)** — dans les DEUX modes (illimité comme limité).
- **Mode limité** (`unlimitedStock !== true`) : `totalCapacity` obligatoire `1..MAX_TOTAL_CAPACITY` ; contrainte **somme(totalStock) ≤ totalCapacity** conservée.
- Blocage backend dur (`BadRequestException`). Messages en **français**.
- **KPI dashboard** : `totals.capacity = event.totalCapacity` (plus la somme des `totalStock` catégories).
- Repos : backend `/Users/user/vybe` (`npx jest`), frontend `/Users/user/vybeFrontend` (`npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`).

---

### Task 1 : Règle de bornage backend (validation + persistance)

**Files:**
- Modify: `src/events/events.service.ts` (constante + bloc stock ~L108-143 + 2 sites de persistance `totalStock` ~L182 et ~L236-237)
- Test: `src/events/events.service.spec.ts` (bloc « stock limité/illimité » ~L149-267)

**Interfaces:**
- Consumes: `dto.ticketCategories` (tableau ordonné), `dto.unlimitedStock`, `dto.totalCapacity`.
- Produces: comportement de `EventsService.createEvent` — persiste `ticketCategories.create[i].totalStock` = `null` seulement si `i === 0 && unlimitedStock`, sinon le plafond fourni ; lève `BadRequestException` sur violation.

- [ ] **Step 1 : Mettre à jour les tests (RED)**

Dans `src/events/events.service.spec.ts`, remplacer le corps du `limitedDto` (les `ticketCategories`, ~L199-202) pour respecter la nouvelle règle (spéciale ≤ 150) :

```ts
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 20000 },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 150 },
      ],
```

Remplacer le test « illimité : … tous à null » (~L207-215) par :

```ts
  it('illimité : base (index 0) à null, spéciales gardent leur plafond', async () => {
    const dto = limitedDto({ unlimitedStock: true, totalCapacity: undefined });
    await service.createEvent('user-1', dto as any);
    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.totalCapacity).toBeNull();
    const stocks = arg.data.ticketCategories.create.map((c: any) => c.totalStock);
    expect(stocks).toEqual([null, 150]); // Standard illimitée, VIP plafonnée
  });

  it('illimité : une spéciale sans totalStock → 400', async () => {
    const dto = limitedDto({
      unlimitedStock: true,
      totalCapacity: undefined,
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1' },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2' }, // spéciale sans plafond
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });

  it('une spéciale > 150 → 400 (illimité comme limité)', async () => {
    const dto = limitedDto({
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 100 },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 200 }, // > 150
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });
```

Remplacer le test « somme > capacité » (~L247-258) pour que ce soit bien la somme (et non le plafond spéciale) qui déclenche :

```ts
  it('limité avec somme > capacité → 400 avec le message exact', async () => {
    const dto = limitedDto({
      totalCapacity: 40000,
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 40000 }, // base ≤ 50000
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 150 }, // spéciale ≤ 150
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(
      'Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.',
    );
  });
```

Mettre à jour l'assertion du test « somme ≤ capacité » (~L260-266) :

```ts
  it('limité avec somme ≤ capacité → crée avec totalCapacity et totalStock corrects', async () => {
    await service.createEvent('user-1', limitedDto() as any);
    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.totalCapacity).toBe(50000);
    const stocks = arg.data.ticketCategories.create.map((c: any) => c.totalStock);
    expect(stocks).toEqual([20000, 150]);
  });
```

Ajouter un test « base > 50000 en limité → 400 » après le test « totalCapacity > 50000 » (~L234) :

```ts
  it('limité avec la base > 50000 → 400', async () => {
    const dto = limitedDto({
      totalCapacity: 50000,
      ticketCategories: [{ name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 50001 }],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });
```

- [ ] **Step 2 : Lancer les tests (échec attendu)**

Run: `cd /Users/user/vybe && npx jest src/events/events.service.spec.ts`
Expected: FAIL — la règle n'existe pas encore (ex. « tous à null » remplacé, spéciale >150 non rejetée).

- [ ] **Step 3 : Ajouter la constante `MAX_SPECIAL_STOCK`**

Dans `src/events/events.service.ts`, sous `const MAX_TOTAL_CAPACITY = 50000;` (~L15) :

```ts
// Plafond des catégories spéciales (toute catégorie hors la 1re/base). Ces billets
// correspondent à des ressources physiques limitées (carré VIP, tables…) : on borne
// dur pour éviter une survente premium, même quand la billetterie globale est illimitée.
const MAX_SPECIAL_STOCK = 150;
```

- [ ] **Step 4 : Réécrire le bloc de validation stock**

Dans `src/events/events.service.ts`, remplacer tout le bloc `// ── Stock : billetterie illimitée … eventCapacity = dto.totalCapacity; }` (actuellement ~L108-143) par :

```ts
    // ── Stock : base (1re catégorie) vs catégories spéciales ──────────────
    // Règle : seule la base (index 0) peut être illimitée. Toute catégorie
    // spéciale (index ≥ 1) doit déclarer un plafond fini ≤ MAX_SPECIAL_STOCK,
    // dans les deux modes (illimité comme limité).
    const cats = dto.ticketCategories;

    for (let i = 1; i < cats.length; i++) {
      const t = cats[i];
      if (t.totalStock == null) {
        throw new BadRequestException(
          `La catégorie spéciale « ${t.name} » doit indiquer un nombre de billets (max ${MAX_SPECIAL_STOCK}).`,
        );
      }
      if (t.totalStock < 1 || t.totalStock > MAX_SPECIAL_STOCK) {
        throw new BadRequestException(
          `La catégorie « ${t.name} » est limitée à ${MAX_SPECIAL_STOCK} billets.`,
        );
      }
    }

    // eventCapacity = capacité totale de l'événement : null en illimité, sinon le nombre choisi.
    let eventCapacity: number | null = null;
    if (dto.unlimitedStock !== true) {
      // Mode limité : capacité totale obligatoire et bornée.
      if (dto.totalCapacity == null) {
        throw new BadRequestException(
          'En stock limité, vous devez indiquer le nombre total de billets.',
        );
      }
      if (dto.totalCapacity < 1 || dto.totalCapacity > MAX_TOTAL_CAPACITY) {
        throw new BadRequestException(
          `Le nombre total de billets doit être compris entre 1 et ${MAX_TOTAL_CAPACITY}.`,
        );
      }
      // Base : plafond obligatoire, borné à MAX_TOTAL_CAPACITY.
      const base = cats[0];
      if (base.totalStock == null) {
        throw new BadRequestException(
          `En stock limité, la catégorie « ${base.name} » doit indiquer son nombre de billets.`,
        );
      }
      if (base.totalStock < 1 || base.totalStock > MAX_TOTAL_CAPACITY) {
        throw new BadRequestException(
          `La catégorie « ${base.name} » est limitée à ${MAX_TOTAL_CAPACITY} billets.`,
        );
      }
      // Somme des allocations ≤ capacité annoncée.
      const sum = cats.reduce((acc, t) => acc + (t.totalStock ?? 0), 0);
      if (sum > dto.totalCapacity) {
        throw new BadRequestException(
          'Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.',
        );
      }
      eventCapacity = dto.totalCapacity;
    }
```

- [ ] **Step 5 : Corriger la persistance (base seule à null en illimité)**

Dans `src/events/events.service.ts`, le `ticketCategories: { create: dto.ticketCategories.map((t) => ({ … })) }` (~L176-186) devient (ajouter l'index `i`) :

```ts
        ticketCategories: {
          create: dto.ticketCategories.map((t, i) => ({
            name: t.name,
            price: t.price,
            ticketDesignUrl: t.ticketDesignUrl,
            // Base (index 0) illimitée → null quand unlimitedStock ; sinon l'allocation validée.
            // Spéciales (index ≥ 1) : toujours leur plafond fini.
            totalStock: i === 0 && dto.unlimitedStock === true ? null : (t.totalStock ?? null),
            maxPerOrder: t.maxPerOrder ?? 10,
            benefits: t.benefits ?? null,
          })),
        },
```

Et le mapping du mail de modération (~L232-238) applique la même logique (ajouter l'index) :

```ts
          ticketCategories: dto.ticketCategories.map((t, i) => ({
            name: t.name,
            price: t.price,
            ticketDesignUrl: t.ticketDesignUrl,
            totalStock: i === 0 && dto.unlimitedStock === true ? null : (t.totalStock ?? null),
          })),
```

- [ ] **Step 6 : Lancer les tests (succès)**

Run: `cd /Users/user/vybe && npx jest src/events/events.service.spec.ts`
Expected: PASS (tous les tests du bloc stock, y compris les nouveaux).

- [ ] **Step 7 : Suite backend complète**

Run: `cd /Users/user/vybe && npx jest`
Expected: toutes les suites vertes (aucune régression sur les autres tests events/orders).

- [ ] **Step 8 : Commit**

```bash
cd /Users/user/vybe
git add src/events/events.service.ts src/events/events.service.spec.ts
git commit -m "feat(events): bornage catégories — base illimitée/≤50000, spéciales ≤150 (blocage backend)"
```

---

### Task 2 : Payload front — spéciales toujours envoyées

**Files:**
- Modify: `src/components/vybe/createEvent.payload.ts` (mapping `ticketCategories`, L50-56)
- Test: `src/components/vybe/createEvent.payload.test.ts`

**Interfaces:**
- Consumes: `EventFormValues` (inchangé).
- Produces: `buildCreateEventPayload` — en illimité, seule `ticketCategories[0].totalStock` est `undefined` ; les spéciales (index ≥ 1) portent toujours leur `totalStock`.

- [ ] **Step 1 : Écrire le test (RED)**

Dans `src/components/vybe/createEvent.payload.test.ts`, ajouter (après le test « en stock illimité … ») :

```ts
  it("en illimité : seule la base (index 0) omet totalStock, les spéciales le gardent", () => {
    const p = buildCreateEventPayload({
      ...base,
      unlimitedStock: true,
      tiers: [
        { name: "Standard", price: 5000, ticketDesign: media("t1"), totalStock: undefined, benefits: "" },
        { name: "VIP", price: 20000, ticketDesign: media("t2"), totalStock: 150, benefits: "" },
      ],
    });
    expect(p.ticketCategories[0].totalStock).toBeUndefined(); // base
    expect(p.ticketCategories[1].totalStock).toBe(150); // spéciale conservée
  });
```

- [ ] **Step 2 : Lancer le test (échec attendu)**

Run: `cd /Users/user/vybeFrontend && npx vitest run src/components/vybe/createEvent.payload.test.ts`
Expected: FAIL — actuellement la spéciale reçoit `undefined` en illimité (`p.ticketCategories[1].totalStock` = undefined).

- [ ] **Step 3 : Corriger le mapping**

Dans `src/components/vybe/createEvent.payload.ts`, remplacer le `.map` (L50-56) :

```ts
    ticketCategories: v.tiers.map((t, i) => ({
      name: t.name,
      price: t.price,
      ticketDesignUrl: t.ticketDesign.url,
      // Base (index 0) : omise en illimité. Spéciales (index ≥ 1) : toujours envoyées (plafond obligatoire).
      totalStock: i === 0 && v.unlimitedStock ? undefined : t.totalStock,
      benefits: t.benefits || undefined,
    })),
```

- [ ] **Step 4 : Lancer les tests (succès)**

Run: `cd /Users/user/vybeFrontend && npx vitest run src/components/vybe/createEvent.payload.test.ts`
Expected: PASS (le test existant « base omet totalStock » reste vert, le nouveau passe).

- [ ] **Step 5 : Commit**

```bash
cd /Users/user/vybeFrontend
git add src/components/vybe/createEvent.payload.ts src/components/vybe/createEvent.payload.test.ts
git commit -m "feat(create-event): payload — spéciales gardent leur totalStock même en illimité"
```

---

### Task 3 : Formulaire front — validation & UI du bornage

**Files:**
- Modify: `src/components/vybe/CreateEvent.tsx` (refinements zod ~L84-86 + rendu du champ totalStock des tiers ~L299-301)

**Interfaces:**
- Consumes: `buildCreateEventPayload` (Task 2), le schéma zod local.
- Produces: le formulaire empêche la soumission d'un payload invalide (base requise en limité ≤ 50000 ; spéciales requises ≤ 150 dans les deux modes) et affiche toujours le champ nombre-de-billets des catégories spéciales.

- [ ] **Step 1 : Remplacer les refinements zod**

Dans `src/components/vybe/CreateEvent.tsx`, remplacer le refinement `.refine((d) => d.unlimitedStock || d.tiers.every((t) => t.totalStock != null), { … })` (~L84-86) par un `superRefine` positionnel (garder le refinement `totalCapacity` juste au-dessus, ~L81-83) :

```ts
  .superRefine((d, ctx) => {
    d.tiers.forEach((t, i) => {
      if (i === 0) {
        // Base : requise seulement en limité, plafond ≤ 50 000.
        if (!d.unlimitedStock) {
          if (t.totalStock == null) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", i, "totalStock"], message: "Indique le nombre de billets" });
          } else if (t.totalStock > 50000) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", i, "totalStock"], message: "Maximum 50 000 billets" });
          }
        }
      } else {
        // Spéciales : toujours plafonnées, 1..150, dans les deux modes.
        if (t.totalStock == null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", i, "totalStock"], message: "Catégorie spéciale : nombre de billets requis (max 150)" });
        } else if (t.totalStock > 150) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tiers", i, "totalStock"], message: "Catégorie spéciale : maximum 150 billets" });
        }
      }
    });
  });
```

- [ ] **Step 2 : Toujours afficher le champ nombre-de-billets des spéciales**

Dans `src/components/vybe/CreateEvent.tsx`, le champ (~L299-301) actuellement `{!unlimited && ( <input …tiers.${i}.totalStock… /> )}` devient (afficher pour toute spéciale, et pour la base seulement en limité) :

```tsx
              {(i > 0 || !unlimited) && (
                <input type="number" {...form.register(`tiers.${i}.totalStock`)}
                  placeholder={i === 0 ? "Nombre de billets pour cette catégorie" : "Nombre de billets (catégorie spéciale, max 150)"}
                  className={inputCls} />
              )}
```

- [ ] **Step 3 : Vérifier types + lint**

Run: `cd /Users/user/vybeFrontend && npx tsc --noEmit && npx eslint src/components/vybe/CreateEvent.tsx`
Expected: aucune erreur.

- [ ] **Step 4 : Suite front + build**

Run: `cd /Users/user/vybeFrontend && npm run test && npm run build`
Expected: toute la suite verte ; build prod OK. (Aucun test ne cible directement le JSX modifié ; la non-régression est portée par typecheck + Task 2.)

- [ ] **Step 5 : Commit**

```bash
cd /Users/user/vybeFrontend
git add src/components/vybe/CreateEvent.tsx
git commit -m "feat(create-event): formulaire — spéciales toujours plafonnées ≤150, base ≤50000/illimitée"
```

---

### Task 4 : KPI scan-dashboard — capacité = `event.totalCapacity`

**Files:**
- Modify: `src/agent/agent.service.ts` (calcul de `capacity` dans `getScanDashboard` + `select` catégories)
- Test: `src/agent/agent.service.spec.ts` (3 tests `getScanDashboard`)
- Modify (doc): `../vybeFrontend/src/types/api.ts` (commentaire `capacity`)

**Interfaces:**
- Consumes: `event.totalCapacity` (déjà chargé par `event.findUnique`).
- Produces: `ScanDashboardResponseDto.totals.capacity === event.totalCapacity` (null = illimité). Le front (`ScanDashboard.tsx`) consomme déjà `totals.capacity` → aucun changement de composant.

- [ ] **Step 1 : Mettre à jour les tests backend (RED)**

Dans `src/agent/agent.service.spec.ts`, dans le mock `prisma.event.findUnique.mockResolvedValue({ … })` du test « agrège totaux… » (~L289-294), ajouter `totalCapacity: null` au retour, et laisser l'assertion `capacity: null`.

Remplacer le test « capacity = somme des totalStock… » (ajouté précédemment) par une lecture directe de `event.totalCapacity` :

```ts
    it('capacity reflète event.totalCapacity (stock limité)', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'e1',
        reference: 'VYBE-8JGBLV',
        title: 'Fête',
        createdById: 'owner',
        totalCapacity: 500,
      });
      prisma.ticket.groupBy
        .mockResolvedValueOnce([{ qrStatus: 'UNUSED', _count: 4 }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);
      prisma.ticketCategory.findMany.mockResolvedValue([
        { id: 'c1', name: 'VIP', soldCount: 4 },
      ]);
      prisma.agent.findMany.mockResolvedValue([]);
      prisma.ticket.findMany.mockResolvedValue([]);

      const res = await service.getScanDashboard('owner', 'VYBE-8JGBLV');

      expect(res.totals.capacity).toBe(500);
    });
```

Dans le test « cas vide » (~L334-339), ajouter `totalCapacity: null` au mock event et changer l'assertion `capacity: 0` → `capacity: null` :

```ts
      expect(res.totals).toEqual({ total: 0, scanned: 0, unused: 0, cancelled: 0, entryRate: 0, capacity: null });
```

(et dans son `prisma.event.findUnique.mockResolvedValue({ … })`, ajouter `totalCapacity: null`.)

- [ ] **Step 2 : Lancer les tests (échec attendu)**

Run: `cd /Users/user/vybe && npx jest src/agent/agent.service.spec.ts -t "getScanDashboard"`
Expected: FAIL — `capacity` provient encore de la somme des catégories (undefined `event.totalCapacity` dans les mocks / valeurs qui ne collent plus).

- [ ] **Step 3 : Lire la capacité depuis l'event**

Dans `src/agent/agent.service.ts`, `getScanDashboard` : remplacer le bloc de calcul de `capacity` (actuellement `const capacity = categories.some((c) => c.totalStock == null) ? null : categories.reduce(...)`) par :

```ts
    // Capacité totale = la jauge annoncée sur l'événement (null = billetterie illimitée).
    const capacity = event.totalCapacity;
```

Et retirer `totalStock: true` du `select` de `ticketCategory.findMany` (il n'est plus utilisé) :

```ts
      select: { id: true, name: true, soldCount: true },
```

(Le `totals: { …, capacity }` du `return` reste inchangé.)

- [ ] **Step 4 : Lancer les tests (succès)**

Run: `cd /Users/user/vybe && npx jest src/agent/agent.service.spec.ts`
Expected: PASS (28 tests du fichier, dont les 6 `getScanDashboard`).

- [ ] **Step 5 : Aligner le commentaire du type front**

Dans `../vybeFrontend/src/types/api.ts`, remplacer le commentaire de `capacity` :

```ts
    /** Capacité totale de l'événement (event.totalCapacity) ; null = billetterie illimitée. */
    capacity: number | null;
```

- [ ] **Step 6 : Vérifs croisées**

Run:
```bash
cd /Users/user/vybe && npx jest
cd /Users/user/vybeFrontend && npx tsc --noEmit && npm run test
```
Expected: backend toutes suites vertes ; front tsc OK + suite verte.

- [ ] **Step 7 : Commit (2 repos)**

```bash
cd /Users/user/vybe
git add src/agent/agent.service.ts src/agent/agent.service.spec.ts
git commit -m "fix(scan-dashboard): capacity = event.totalCapacity (au lieu de la somme des catégories)"
cd /Users/user/vybeFrontend
git add src/types/api.ts
git commit -m "docs(scan-dashboard): capacity = event.totalCapacity"
```

---

## Self-review

- **Couverture** : règle base/spéciale (Task 1) ; front cohérent payload (Task 2) + validation/UI (Task 3) ; KPI capacité aligné (Task 4). Le garde-fou « ≤ 1 illimitée » est une conséquence de « spéciales toujours finies » (Task 1) — pas de code séparé.
- **Cas limites couverts** : spéciale sans stock, spéciale > 150, base > 50000, somme > capacité, illimité (base null + spéciale finie), cas vide dashboard.
- **Cohérence types** : `MAX_SPECIAL_STOCK` (150), `MAX_TOTAL_CAPACITY` (50000), identification positionnelle `[0]`/`[i≥1]` employées identiquement backend + front. `totals.capacity` inchangé côté signature.
- **Hypothèse** : `event.totalCapacity` est bien retourné par `event.findUnique` sans `select` explicite (record complet) — vrai dans `getScanDashboard`.
