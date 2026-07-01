# Stock des billets : limité / illimité — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre au créateur d'un événement de choisir, au niveau de l'événement, une billetterie **illimitée** (toutes catégories) ou **limitée** (capacité totale ≤ 50 000 répartie entre les catégories, sans dépasser cette capacité).

**Architecture:** Changement de périmètre côté **création** uniquement. Choix exprimé au niveau de l'`Event` via un booléen `unlimitedStock` (le radio) + `totalCapacity`. Chaque `TicketCategory` porte son allocation `totalStock`. Toute la validation métier vit dans `EventsService.createEvent`, à côté des règles existantes (dates, affiche, 1–4 catégories). Le flux d'achat (décrément, génération/multiplication des QR jusqu'au jour J) reste **hors périmètre**.

**Tech Stack:** NestJS, TypeScript, Prisma (PostgreSQL), class-validator, Jest.

## Requirements & règles métier (issus du brainstorming)

- **Choix au niveau de l'événement** (pas par catégorie) : `unlimitedStock?: boolean` (la case « illimité »). **Non coché / absent / `false` → limité** ; seul `true` → illimité. Le champ est donc **optionnel** (défaut = limité).
- **Flux illimité** (`unlimitedStock = true`) : toutes les catégories sont illimitées. En base : `Event.totalCapacity = null` et chaque `TicketCategory.totalStock = null`. (La multiplication du QR unique par billet jusqu'au jour de l'événement relève du **flux d'achat futur**, non couvert ici.)
- **Flux limité** (`unlimitedStock = false`) :
  - `totalCapacity` **requis**, entier, **1 ≤ totalCapacity ≤ 50 000** (`MAX_TOTAL_CAPACITY = 50000` ; 50 000 est autorisé).
  - **Chaque** catégorie doit fournir `totalStock` (entier ≥ 1).
  - **`somme(totalStock) ≤ totalCapacity`**. Si dépassement → erreur avec le message **exact** :
    `Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.`
  - La somme peut être **inférieure** à `totalCapacity` (le créateur n'est pas obligé de tout allouer ; le reliquat = capacité déclarée non vendue). Décision : on tolère `≤`, on n'exige pas `=`.

### Décisions annexes (défauts retenus, modifiables)

- **Plafond 50 000 = limite globale de l'application** (le maximum de billets qu'un événement peut déclarer en mode limité, quelle que soit la salle). Constante nommée `MAX_TOTAL_CAPACITY = 50000` dans `EventsService`. Comme c'est un réglage applicatif, il pourra être déplacé dans une variable d'env (`MAX_TICKETS_PER_EVENT`) le jour où on veut le changer sans redéployer — pas fait maintenant (YAGNI).
- **Fenêtre de vente « jusqu'au jour de l'événement »** : aucun nouveau champ. Le modèle a déjà `purchaseDeadline` (≤ `startDate`). Pour vendre jusqu'au jour J, le créateur met `purchaseDeadline = startDate`. L'application effective de cette fenêtre (et la génération/multiplication du QR) relève du **flux d'achat futur**.
- **`maxPerOrder`** : hors périmètre de ce plan (question ouverte séparée : défaut 10, éventuel `maxPerOrder ≤ totalStock`). On ne le touche pas ici.
- **`totalCapacity` stocké** (choix « tout-ou-rien + capacité »), pas dérivé.

## Global Constraints

- Commentaires et messages d'erreur **en français**.
- Enums Prisma via `import { $Enums } from '@prisma/client'`.
- `PrismaService` importé depuis `src/prisma/prisma.service`.
- `ValidationPipe` global actif (`whitelist`, `forbidNonWhitelisted`, `transform`).
- Tests : `npx jest src/<chemin>.spec.ts`.
- `MAX_TOTAL_CAPACITY = 50000` (constante partagée dans `EventsService`).
- Message de dépassement **verbatim** : `Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.`
- Travailler sur une branche dédiée (ex. `feat/ticket-stock-limits`), pas sur `main`.
- Un commit par tâche.

---

### Task 1: Migration — ajouter `Event.totalCapacity`

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: `Event.totalCapacity: Int?` (null = billetterie illimitée ; sinon capacité totale ≤ 50 000). `TicketCategory.totalStock: Int?` existe déjà — aucun changement.

- [ ] **Step 1: Ajouter le champ sur `Event`**

Dans `prisma/schema.prisma`, `model Event`, après la ligne `reviewedAt    DateTime?    // date de la décision de modération (validation/refus)`, ajouter :

```prisma
  totalCapacity Int?         // null = billetterie illimitée ; sinon capacité totale (max 50000)
```

- [ ] **Step 2: Créer et appliquer la migration**

Run: `npx prisma migrate dev --name event_ticket_stock_capacity`
Expected: `Your database is now in sync with your schema.`

- [ ] **Step 3: Régénérer le client Prisma**

Run: `npx prisma generate`
Expected: `Generated Prisma Client` sans erreur.

- [ ] **Step 4: Vérifier la compilation**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(events): ajout de Event.totalCapacity pour la billetterie limitée"
```

---

### Task 2: DTOs — choix illimité + capacité + allocation par catégorie

**Files:**
- Modify: `src/events/dto/create-event.dto.ts`
- Modify: `src/events/dto/ticket-category.dto.ts`

**Interfaces:**
- Produces: `CreateEventDto.unlimitedStock: boolean`, `CreateEventDto.totalCapacity?: number`, `TicketCategoryDto.totalStock?: number`.

- [ ] **Step 1: Étendre les imports de `create-event.dto.ts`**

Dans `src/events/dto/create-event.dto.ts`, remplacer le bloc d'import `class-validator` par (ajout de `IsBoolean`, `IsInt`, `Min`) :

```typescript
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
```

- [ ] **Step 2: Ajouter les champs stock à `CreateEventDto`**

Dans `src/events/dto/create-event.dto.ts`, juste avant le champ `media` (la ligne `@IsArray()` qui précède `media: MediaItemDto[];`), insérer :

```typescript
  // Case « illimité » au niveau de l'événement. Non cochée / absente / false = limité ;
  // seul true = illimité pour toutes les catégories.
  @IsOptional()
  @IsBoolean()
  unlimitedStock?: boolean;

  // Requis uniquement en stock limité (unlimitedStock = false). Borné à 50 000 côté service.
  @IsOptional()
  @IsInt()
  @Min(1)
  totalCapacity?: number;

```

- [ ] **Step 3: Ajouter `totalStock` à `TicketCategoryDto`**

Dans `src/events/dto/ticket-category.dto.ts`, après le champ `ticketDesignUrl` (avant `maxPerOrder`), insérer :

```typescript
  // Requis uniquement en stock limité : allocation de billets pour cette catégorie.
  @IsOptional()
  @IsInt()
  @Min(1)
  totalStock?: number;

```

- [ ] **Step 4: Vérifier la compilation**

Run: `npm run build`
Expected: build échoue sur `src/events/events.service.spec.ts` (le `baseDto` n'a pas encore `unlimitedStock`) — **c'est attendu**, corrigé en Task 3. Vérifier qu'il n'y a **pas** d'erreur dans les fichiers DTO eux-mêmes.

- [ ] **Step 5: Commit**

```bash
git add src/events/dto/create-event.dto.ts src/events/dto/ticket-category.dto.ts
git commit -m "feat(events): DTO du choix stock illimité/limité + allocation par catégorie"
```

---

### Task 3: EventsService — validation + persistance du stock

**Files:**
- Modify: `src/events/events.service.ts`
- Test: `src/events/events.service.spec.ts`

**Interfaces:**
- Consumes: `CreateEventDto.unlimitedStock`, `CreateEventDto.totalCapacity`, `TicketCategoryDto.totalStock`.
- Produces: `createEvent` persiste `Event.totalCapacity` et `TicketCategory.totalStock` selon le choix ; lève `BadRequestException` en cas de règle violée.

- [ ] **Step 1: Mettre à jour le `baseDto` et ajouter les tests (échouent)**

Dans `src/events/events.service.spec.ts`, dans la fonction `baseDto`, ajouter la propriété `unlimitedStock: true,` juste après `termsAccepted: true,`. Puis ajouter ce `describe` supplémentaire à la fin du fichier (avant la dernière `});` de fermeture du describe racine — ou comme nouveau describe indépendant en fin de fichier) :

```typescript
describe('EventsService.createEvent — stock limité/illimité', () => {
  let service: EventsService;
  let prisma: any;
  let mail: any;
  let moderation: any;

  beforeEach(() => {
    prisma = {
      event: {
        create: jest
          .fn()
          .mockResolvedValue({ id: 'evt-1', status: 'PENDING_REVIEW', title: 'Soirée', createdBy: { email: 'u@x.com' } }),
      },
    };
    mail = { sendEventModerationEmail: jest.fn().mockResolvedValue(undefined) };
    moderation = { generateModerationToken: jest.fn().mockReturnValue('tok') };
    service = new EventsService(prisma, mail, moderation);
    process.env.API_BASE_URL = 'https://api.test';
    process.env.VYBE_TEAM_EMAIL = 'team@vybe.app';
  });

  function limitedDto(overrides: any = {}) {
    return {
      title: 'Soirée',
      description: 'desc',
      startDate: '2030-01-01T20:00:00Z',
      endDate: '2030-01-01T23:00:00Z',
      location: 'Kinshasa',
      purchaseDeadline: '2030-01-01T18:00:00Z',
      category: 'CONCERT',
      termsAccepted: true,
      unlimitedStock: false,
      totalCapacity: 50000,
      media: [
        { url: 'u', fileKey: 'k', fileName: 'a.png', mimeType: 'image/png', sizeBytes: 1, mediaType: 'IMAGE', isPoster: true },
      ],
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 20000 },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 30000 },
      ],
      ...overrides,
    };
  }

  it('illimité : totalCapacity et tous les totalStock sont mis à null', async () => {
    const dto = limitedDto({ unlimitedStock: true, totalCapacity: undefined });
    await service.createEvent('user-1', dto as any);
    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.totalCapacity).toBeNull();
    expect(arg.data.ticketCategories.create.every((c: any) => c.totalStock === null)).toBe(true);
  });

  it('limité sans totalCapacity → 400', async () => {
    const dto = limitedDto({ totalCapacity: undefined });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });

  it('limité avec totalCapacity > 50000 → 400', async () => {
    const dto = limitedDto({ totalCapacity: 50001, ticketCategories: [{ name: 'A', price: 1, ticketDesignUrl: 'd', totalStock: 1 }] });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });

  it('limité avec une catégorie sans totalStock → 400', async () => {
    const dto = limitedDto({ ticketCategories: [{ name: 'Standard', price: 10, ticketDesignUrl: 'd1' }] });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });

  it('limité avec somme > capacité → 400 avec le message exact', async () => {
    const dto = limitedDto({
      totalCapacity: 50000,
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 30000 },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 25000 },
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(
      'Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.',
    );
  });

  it('limité avec somme ≤ capacité → crée avec totalCapacity et totalStock corrects', async () => {
    await service.createEvent('user-1', limitedDto() as any);
    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.totalCapacity).toBe(50000);
    const stocks = arg.data.ticketCategories.create.map((c: any) => c.totalStock);
    expect(stocks).toEqual([20000, 30000]);
  });
});
```

- [ ] **Step 2: Lancer les tests pour vérifier l'échec**

Run: `npx jest src/events/events.service.spec.ts`
Expected: FAIL (les nouveaux cas échouent ; le champ `totalCapacity` n'est pas encore géré).

- [ ] **Step 3: Ajouter la constante de capacité maximale**

Dans `src/events/events.service.ts`, juste après les imports (avant `@Injectable()`), ajouter :

```typescript
const MAX_TOTAL_CAPACITY = 50000;
```

- [ ] **Step 4: Ajouter la validation du stock**

Dans `src/events/events.service.ts`, dans `createEvent`, juste **après** le bloc qui valide `dto.ticketCategories.length` (le `if (dto.ticketCategories.length < 1 || dto.ticketCategories.length > 4)`), insérer :

```typescript
    // ── Stock : billetterie illimitée ou limitée (choix au niveau de l'événement) ──
    let eventCapacity: number | null = null;
    if (!dto.unlimitedStock) {
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
      let sum = 0;
      for (const t of dto.ticketCategories) {
        if (t.totalStock == null) {
          throw new BadRequestException(
            `En stock limité, la catégorie « ${t.name} » doit indiquer son nombre de billets.`,
          );
        }
        sum += t.totalStock;
      }
      if (sum > dto.totalCapacity) {
        throw new BadRequestException(
          'Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.',
        );
      }
      eventCapacity = dto.totalCapacity;
    }
```

- [ ] **Step 5: Persister `totalCapacity` sur l'événement**

Dans `src/events/events.service.ts`, dans l'objet `data` du `prisma.event.create`, après la ligne `status: $Enums.EventStatus.PENDING_REVIEW,`, ajouter :

```typescript
        totalCapacity: eventCapacity,
```

- [ ] **Step 6: Persister `totalStock` par catégorie**

Dans `src/events/events.service.ts`, dans le `ticketCategories.create.map(...)`, remplacer la ligne `totalStock: null, // stock illimité` par :

```typescript
            totalStock: dto.unlimitedStock ? null : (t.totalStock ?? null),
```

- [ ] **Step 7: Lancer les tests pour vérifier le succès**

Run: `npx jest src/events/events.service.spec.ts`
Expected: PASS (anciens tests + 6 nouveaux cas stock).

- [ ] **Step 8: Commit**

```bash
git add src/events/events.service.ts src/events/events.service.spec.ts
git commit -m "feat(events): validation et persistance du stock limité/illimité"
```

---

### Task 4 (OPTIONNELLE) : Mail de modération — afficher la capacité et le stock par catégorie

> Ajout de confort, hors demande initiale. Peut être ignorée sans impact sur la fonctionnalité.


**Files:**
- Modify: `src/mail/mail.service.ts`
- Modify: `src/events/events.service.ts`
- Test: `src/mail/mail.service.spec.ts`

**Interfaces:**
- Consumes: `ModerationEmailParams` étendu.
- Produces: `ModerationEmailParams.totalCapacity: number | null` ; chaque item de `ticketCategories` gagne `totalStock: number | null`.

- [ ] **Step 1: Mettre à jour le test du mail (échoue)**

Dans `src/mail/mail.service.spec.ts`, dans l'appel `service.sendEventModerationEmail({...})` du premier test, ajouter `totalCapacity: 50000,` dans l'objet, et remplacer la ligne des `ticketCategories` par :

```typescript
      ticketCategories: [
        { name: 'VIP', price: 100, ticketDesignUrl: 'https://cdn/vip.png', totalStock: 500 },
      ],
```

Puis, dans le même test, ajouter ces assertions avant la fin :

```typescript
    expect(msg.html).toContain('50000');
    expect(msg.html).toContain('500');
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/mail/mail.service.spec.ts`
Expected: FAIL (le HTML ne contient pas encore la capacité/stock, et/ou erreur de type sur `totalCapacity`).

- [ ] **Step 3: Étendre `ModerationEmailParams`**

Dans `src/mail/mail.service.ts`, dans `export interface ModerationEmailParams`, remplacer la ligne :

```typescript
  ticketCategories: { name: string; price: number; ticketDesignUrl: string }[];
```

par :

```typescript
  totalCapacity: number | null;
  ticketCategories: {
    name: string;
    price: number;
    ticketDesignUrl: string;
    totalStock: number | null;
  }[];
```

- [ ] **Step 4: Afficher la capacité et le stock dans le HTML**

Dans `src/mail/mail.service.ts`, méthode `sendEventModerationEmail` :

(a) Dans le template des lignes de billets `ticketsRows`, ajouter une cellule stock. Remplacer le `<td>` contenant l'image du design par ces deux `<td>` :

```typescript
          <td style="padding:8px 12px;color:#ddd;border-bottom:1px solid #222;">${t.totalStock == null ? 'Illimité' : t.totalStock}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;">
            <img src="${t.ticketDesignUrl}" alt="design ${t.name}" width="80" style="border-radius:6px;"/>
          </td>
```

(b) Dans l'en-tête du tableau des billets (les `<th>`), ajouter une colonne « Stock » avant « Design » :

```typescript
              <th style="text-align:left;padding:8px 12px;color:#888;font-size:12px;">Stock</th>
```

(c) Dans la table d'infos de l'événement, ajouter une ligne capacité — après `${row('Limite achat', fmt(params.purchaseDeadline))}` :

```typescript
            ${row('Billetterie', params.totalCapacity == null ? 'Illimitée' : `Limitée — ${params.totalCapacity} billets`)}
```

- [ ] **Step 5: Passer les nouvelles données depuis `EventsService`**

Dans `src/events/events.service.ts`, dans l'appel `this.mailService.sendEventModerationEmail({...})` :

(a) après la ligne `creatorLabel: event.createdBy?.email ?? userId,` ajouter :

```typescript
      totalCapacity: eventCapacity,
```

(b) remplacer le bloc `ticketCategories: dto.ticketCategories.map((t) => ({ name: t.name, price: t.price, ticketDesignUrl: t.ticketDesignUrl }))` par :

```typescript
      ticketCategories: dto.ticketCategories.map((t) => ({
        name: t.name,
        price: t.price,
        ticketDesignUrl: t.ticketDesignUrl,
        totalStock: dto.unlimitedStock ? null : (t.totalStock ?? null),
      })),
```

- [ ] **Step 6: Lancer les tests concernés**

Run: `npx jest src/mail/mail.service.spec.ts src/events/events.service.spec.ts`
Expected: PASS (tous).

- [ ] **Step 7: Vérifier le build et le démarrage**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 8: Commit**

```bash
git add src/mail/mail.service.ts src/events/events.service.ts src/mail/mail.service.spec.ts
git commit -m "feat(events): affiche la capacité et le stock par catégorie dans le mail de modération"
```

---

## Self-Review (effectué)

- **Couverture des règles :** choix événement (T2), illimité → null partout (T3), limité requiert capacité 1..50000 (T3), catégorie limitée requiert totalStock (T3), somme ≤ capacité + message exact (T3), persistance capacité + stock (T3), affichage modération (T4). ✅
- **Placeholders :** aucun — code complet à chaque étape. ✅
- **Cohérence des types :** `totalCapacity: number | null` (params mail + champ Event), `totalStock: number | null` (catégorie), `unlimitedStock: boolean`, `MAX_TOTAL_CAPACITY = 50000`, message verbatim — cohérents entre DTO, service, mail et tests. ✅

## Hors périmètre (flux d'achat futur)

- Décrément atomique du stock à l'achat (anti-survente), génération/multiplication du QR unique par billet jusqu'au jour de l'événement, blocage des ventes une fois `totalStock`/`totalCapacity` atteint.
