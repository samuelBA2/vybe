# Brique D — Génération des visuels du billet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Après un achat, générer pour chaque billet un PNG (design + QR + ruban de catégorie) et un PDF, les héberger sur Cloudinary et stocker leurs URLs sur le `Ticket`.

**Architecture:** Un module dédié `src/tickets/` porte un `TicketAssetService` (génération QR + composition `sharp` + PDF `pdfkit` + upload Cloudinary + update Prisma). `OrderService` l'appelle en post-commit best-effort (hors transaction). La logique est isolée pour être réutilisée par la brique C (rattrapage paresseux).

**Tech Stack:** NestJS · Prisma · `qrcode` (déjà installé) · `sharp` · `pdfkit` · Cloudinary (`CloudinaryService`).

## Global Constraints

- Node 20, projet CommonJS. `fetch` global disponible (pas d'import).
- Tests : Jest, fichiers `*.spec.ts`, `rootDir: src`, alias `^src/(.*)$` → `<rootDir>/$1`. Lancer un fichier : `npx jest src/chemin/fichier.spec.ts`.
- Commentaires et messages en **français**. **Pas** de `Co-Authored-By` dans les commits.
- Le QR encode le `qrToken` **brut** (UUID v4, texte nu) — imposé par `ScanDto @IsUUID('4')`. Ne jamais préfixer/wrapper.
- Best-effort : la génération **ne doit jamais** faire échouer `POST /orders`.
- `CloudinaryFolder.TICKETS` (`'vybe/tickets'`) existe déjà — l'utiliser.
- Ne pas recréer les DTO CRUD auto-générés supprimés (cf. CLAUDE.md).

---

## File Structure

- `prisma/schema.prisma` — ajout `Ticket.ticketImageUrl String?`.
- `src/tickets/ticket-palette.ts` — palette + `colorForCategoryName()`.
- `src/tickets/ticket-palette.spec.ts` — test palette.
- `src/tickets/ticket-asset.service.ts` — `TicketAssetService`.
- `src/tickets/ticket-asset.service.spec.ts` — tests service.
- `src/tickets/tickets.module.ts` — module (importe `CloudinaryModule`+`PrismaModule`, exporte le service).
- `src/cloudinary/cloudinary.service.ts` — ajout `uploadRawBuffer()`.
- `src/cloudinary/cloudinary.service.spec.ts` — test `uploadRawBuffer` (nouveau fichier).
- `src/orders/Order.service.ts` — intégration post-commit.
- `src/orders/Order.service.spec.ts` — adapter (mock du nouveau service).
- `src/orders/Order.module.ts` — importer `TicketsModule`.

---

### Task 1: Migration Prisma — `Ticket.ticketImageUrl`

**Files:**
- Modify: `prisma/schema.prisma` (modèle `Ticket`, après `pdfUrl String?`)

**Interfaces:**
- Produces: colonne `ticketImageUrl String?` sur `Ticket` (client Prisma régénéré).

- [ ] **Step 1: Ajouter le champ au schéma**

Dans `model Ticket`, juste après la ligne `pdfUrl           String?` :

```prisma
  pdfUrl           String?
  ticketImageUrl   String?   // URL Cloudinary du PNG composé (design + QR + ruban de catégorie)
```

- [ ] **Step 2: Créer et appliquer la migration**

Run: `npx prisma migrate dev --name add_ticket_image_url`
Expected: migration créée sous `prisma/migrations/…_add_ticket_image_url/` et appliquée sans erreur ; « Your database is now in sync ».

- [ ] **Step 3: Vérifier la régénération du client**

Run: `npx prisma generate`
Expected: « Generated Prisma Client » sans erreur.

- [ ] **Step 4: Vérifier que le build compile**

Run: `npm run build`
Expected: build OK (le champ est optionnel, aucun code ne casse encore).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(tickets): ajoute Ticket.ticketImageUrl (URL du PNG composé)"
```

---

### Task 2: Palette de couleurs par catégorie

**Files:**
- Create: `src/tickets/ticket-palette.ts`
- Test: `src/tickets/ticket-palette.spec.ts`

**Interfaces:**
- Produces:
  - `export const TICKET_PALETTE: string[]`
  - `export function colorForCategoryName(name: string): string` — déterministe, insensible à la casse/espaces/accents, renvoie une valeur de `TICKET_PALETTE`.

- [ ] **Step 1: Écrire le test qui échoue**

`src/tickets/ticket-palette.spec.ts` :

```ts
import { TICKET_PALETTE, colorForCategoryName } from './ticket-palette';

describe('colorForCategoryName', () => {
  it('renvoie toujours une couleur de la palette', () => {
    expect(TICKET_PALETTE).toContain(colorForCategoryName('VIP'));
    expect(TICKET_PALETTE).toContain(colorForCategoryName('Standard'));
  });

  it('est déterministe pour un même nom', () => {
    expect(colorForCategoryName('VVIP')).toBe(colorForCategoryName('VVIP'));
  });

  it('est insensible à la casse, aux espaces et aux accents', () => {
    expect(colorForCategoryName('  vip ')).toBe(colorForCategoryName('VIP'));
    expect(colorForCategoryName('Prémium')).toBe(colorForCategoryName('premium'));
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/tickets/ticket-palette.spec.ts`
Expected: FAIL (« Cannot find module './ticket-palette' »).

- [ ] **Step 3: Écrire l'implémentation**

`src/tickets/ticket-palette.ts` :

```ts
// Palette curée à fort contraste : chaque catégorie de billet reçoit une couleur
// dérivée déterministe de son nom (cohérence de branding entre événements).
export const TICKET_PALETTE: string[] = [
  '#E11D48', // rose/rouge
  '#F59E0B', // ambre
  '#10B981', // émeraude
  '#3B82F6', // bleu
  '#8B5CF6', // violet
  '#EC4899', // magenta
  '#14B8A6', // teal
  '#F97316', // orange
];

// Hash djb2, stable, sans dépendance.
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h;
}

export function colorForCategoryName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // retire les diacritiques
  return TICKET_PALETTE[hash(normalized) % TICKET_PALETTE.length];
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest src/tickets/ticket-palette.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/tickets/ticket-palette.ts src/tickets/ticket-palette.spec.ts
git commit -m "feat(tickets): palette déterministe de couleur par nom de catégorie"
```

---

### Task 3: `CloudinaryService.uploadRawBuffer` (upload PDF depuis un buffer)

**Files:**
- Modify: `src/cloudinary/cloudinary.service.ts` (ajout d'une méthode)
- Test: `src/cloudinary/cloudinary.service.spec.ts` (nouveau)

**Interfaces:**
- Consumes: `UploadApiResponse` (déjà importé dans le fichier).
- Produces: `uploadRawBuffer(buffer: Buffer, folder: string, filename: string): Promise<UploadApiResponse>` — upload `resource_type: 'raw'`, `format: 'pdf'`, `public_id: filename`.

- [ ] **Step 1: Écrire le test qui échoue**

`src/cloudinary/cloudinary.service.spec.ts` :

```ts
import { Writable } from 'stream';

const uploadStreamMock = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { uploader: { upload_stream: (...args: any[]) => uploadStreamMock(...args) } },
}));

import { CloudinaryService } from './cloudinary.service';

describe('CloudinaryService.uploadRawBuffer', () => {
  beforeEach(() => {
    uploadStreamMock.mockReset();
    // Simule Cloudinary : renvoie un flux inscriptible et déclenche le callback succès.
    uploadStreamMock.mockImplementation((_opts: any, cb: any) => {
      const sink = new Writable({ write(_c, _e, done) { done(); } });
      process.nextTick(() => cb(null, { secure_url: 'https://cdn/x.pdf', public_id: 'p' }));
      return sink;
    });
  });

  it('upload en resource_type raw et renvoie le résultat', async () => {
    const service = new CloudinaryService();
    const res = await service.uploadRawBuffer(Buffer.from('%PDF-1.4'), 'vybe/tickets', 'ticket-1');
    expect(res.secure_url).toBe('https://cdn/x.pdf');
    const opts = uploadStreamMock.mock.calls[0][0];
    expect(opts.resource_type).toBe('raw');
    expect(opts.format).toBe('pdf');
    expect(opts.public_id).toBe('ticket-1');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/cloudinary/cloudinary.service.spec.ts`
Expected: FAIL (« uploadRawBuffer is not a function »).

- [ ] **Step 3: Écrire l'implémentation**

Dans `src/cloudinary/cloudinary.service.ts`, ajouter la méthode dans la classe (à côté de `uploadBuffer`) :

```ts
  // Upload d'un PDF généré côté serveur (billet). resource_type 'raw' : Cloudinary
  // stocke le fichier tel quel, sans transformation image.
  async uploadRawBuffer(
    buffer: Buffer,
    folder: string,
    filename: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: 'raw',
          public_id: filename,
          format: 'pdf',
        },
        (error, result) => {
          if (error) return reject(error);
          if (!result) return reject(new Error('Upload Cloudinary sans résultat.'));
          resolve(result);
        },
      );
      Readable.from(buffer).pipe(upload);
    });
  }
```

(`Readable` et `cloudinary` sont déjà importés en haut du fichier.)

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest src/cloudinary/cloudinary.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cloudinary/cloudinary.service.ts src/cloudinary/cloudinary.service.spec.ts
git commit -m "feat(cloudinary): uploadRawBuffer pour héberger un PDF généré"
```

---

### Task 4: `TicketAssetService.buildTicketImage` (QR + composition sharp)

**Files:**
- Create: `src/tickets/ticket-asset.service.ts`
- Test: `src/tickets/ticket-asset.service.spec.ts`

**Setup:** `npm i sharp` (native ; `qrcode` déjà installé).

**Interfaces:**
- Consumes: `colorForCategoryName` (Task 2).
- Produces: `buildTicketImage(designBuffer: Buffer, qrToken: string, categoryName: string): Promise<Buffer>` — renvoie un PNG dont la hauteur = hauteur du design + `BAND_HEIGHT` (bandeau blanc du bas), avec le QR centré dans le bandeau et un ruban coloré dans le coin **haut-droit**.

- [ ] **Step 1: Installer sharp**

Run: `npm i sharp`
Expected: installé sans erreur.

- [ ] **Step 2: Écrire le test qui échoue**

`src/tickets/ticket-asset.service.spec.ts` :

```ts
import sharp from 'sharp';
import * as QRCode from 'qrcode';
import { TicketAssetService } from './ticket-asset.service';

// Petite image de design synthétique (unie) pour tester la composition réelle.
async function makeDesign(w: number, h: number): Promise<Buffer> {
  return sharp({
    create: { width: w, height: h, channels: 3, background: '#334155' },
  }).png().toBuffer();
}

describe('TicketAssetService.buildTicketImage', () => {
  const service = new TicketAssetService({} as any, {} as any);

  it('ajoute un bandeau sous le design (hauteur augmentée, largeur inchangée)', async () => {
    const design = await makeDesign(600, 800);
    const png = await service.buildTicketImage(design, '11111111-1111-4111-8111-111111111111', 'VIP');
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(800 + TicketAssetService.BAND_HEIGHT);
  });

  it('encode le qrToken brut dans le QR', async () => {
    const spy = jest.spyOn(QRCode, 'toBuffer');
    const design = await makeDesign(400, 400);
    await service.buildTicketImage(design, '22222222-2222-4222-8222-222222222222', 'Standard');
    expect(spy.mock.calls[0][0]).toBe('22222222-2222-4222-8222-222222222222');
    spy.mockRestore();
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier l'échec**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts`
Expected: FAIL (« Cannot find module './ticket-asset.service' »).

- [ ] **Step 4: Écrire l'implémentation (partie image)**

`src/tickets/ticket-asset.service.ts` :

```ts
import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import * as QRCode from 'qrcode';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';
import { CloudinaryFolder } from 'src/cloudinary/cloudinary.folder';
import { colorForCategoryName } from './ticket-palette';

// Échappe le nom de catégorie (saisie utilisateur) avant insertion dans le SVG.
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string),
  );
}

@Injectable()
export class TicketAssetService {
  static readonly BAND_HEIGHT = 260; // hauteur du bandeau blanc du bas (px)
  static readonly QR_SIZE = 220;     // côté du QR (px)
  private readonly logger = new Logger(TicketAssetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // Construit le PNG du billet : design + bandeau QR (bas) + ruban catégorie (coin haut-droit).
  async buildTicketImage(
    designBuffer: Buffer,
    qrToken: string,
    categoryName: string,
  ): Promise<Buffer> {
    const meta = await sharp(designBuffer).metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    const BAND = TicketAssetService.BAND_HEIGHT;
    const QR = TicketAssetService.QR_SIZE;

    // 1) QR PNG à partir du qrToken brut.
    const qrPng = await QRCode.toBuffer(qrToken, {
      width: QR,
      margin: 1,
      errorCorrectionLevel: 'M',
    });

    // 2) Ruban SVG dans le coin haut-droit.
    const side = Math.round(Math.min(W, H) * 0.42);
    const color = colorForCategoryName(categoryName);
    const label = escapeXml(categoryName.toUpperCase());
    const ribbon = Buffer.from(`
      <svg width="${side}" height="${side}" xmlns="http://www.w3.org/2000/svg">
        <polygon points="${side * 0.3},0 ${side},0 ${side},${side * 0.7}" fill="${color}"/>
        <text x="${side * 0.65}" y="${side * 0.35}"
          transform="rotate(45 ${side * 0.65} ${side * 0.35})"
          font-family="Arial, sans-serif" font-size="${Math.round(side * 0.12)}"
          font-weight="bold" fill="#ffffff" text-anchor="middle"
          dominant-baseline="middle">${label}</text>
      </svg>`);

    // 3) Bandeau blanc sous le design.
    const extended = await sharp(designBuffer)
      .extend({ top: 0, bottom: BAND, left: 0, right: 0, background: '#ffffff' })
      .toBuffer();

    // 4) Composition : QR centré dans le bandeau + ruban au coin haut-droit.
    return sharp(extended)
      .composite([
        { input: qrPng, left: Math.round((W - QR) / 2), top: H + Math.round((BAND - QR) / 2) },
        { input: ribbon, left: Math.max(0, W - side), top: 0 },
      ])
      .png()
      .toBuffer();
  }
}
```

- [ ] **Step 5: Lancer le test pour vérifier le succès**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/tickets/ticket-asset.service.ts src/tickets/ticket-asset.service.spec.ts
git commit -m "feat(tickets): composition du PNG du billet (QR + ruban de catégorie)"
```

---

### Task 5: `TicketAssetService.buildTicketPdf` (pdfkit)

**Files:**
- Modify: `src/tickets/ticket-asset.service.ts` (ajout méthode)
- Test: `src/tickets/ticket-asset.service.spec.ts` (ajout describe)

**Setup:** `npm i pdfkit && npm i -D @types/pdfkit`.

**Interfaces:**
- Produces: `buildTicketPdf(pngBuffer: Buffer): Promise<Buffer>` — PDF mono-page dimensionné au PNG, image bord à bord. Le buffer commence par `%PDF`.

- [ ] **Step 1: Installer pdfkit**

Run: `npm i pdfkit && npm i -D @types/pdfkit`
Expected: installés sans erreur.

- [ ] **Step 2: Écrire le test qui échoue**

Ajouter dans `src/tickets/ticket-asset.service.spec.ts` :

```ts
describe('TicketAssetService.buildTicketPdf', () => {
  const service = new TicketAssetService({} as any, {} as any);

  it('renvoie un buffer PDF (magic %PDF)', async () => {
    const png = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#000000' },
    }).png().toBuffer();
    const pdf = await service.buildTicketPdf(png);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
```

- [ ] **Step 3: Lancer le test pour vérifier l'échec**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts -t "buildTicketPdf"`
Expected: FAIL (« buildTicketPdf is not a function »).

- [ ] **Step 4: Écrire l'implémentation**

En haut de `src/tickets/ticket-asset.service.ts`, ajouter l'import :

```ts
import PDFDocument from 'pdfkit';
```

Puis, dans la classe, ajouter la méthode :

```ts
  // Emballe le PNG du billet dans un PDF mono-page à ses dimensions exactes.
  async buildTicketPdf(pngBuffer: Buffer): Promise<Buffer> {
    const meta = await sharp(pngBuffer).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    return new Promise<Buffer>((resolve, reject) => {
      const doc = new PDFDocument({ size: [w, h], margin: 0 });
      const chunks: Buffer[] = [];
      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.image(pngBuffer, 0, 0, { width: w, height: h });
      doc.end();
    });
  }
```

- [ ] **Step 5: Lancer le test pour vérifier le succès**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts`
Expected: PASS (3 tests au total dans le fichier).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/tickets/ticket-asset.service.ts src/tickets/ticket-asset.service.spec.ts
git commit -m "feat(tickets): génération du PDF du billet à partir du PNG"
```

---

### Task 6: `generateAssetsForOrder` (orchestration) + `TicketsModule`

**Files:**
- Modify: `src/tickets/ticket-asset.service.ts` (ajout méthodes `generateAssetsForOrder` + `fetchDesign`)
- Create: `src/tickets/tickets.module.ts`
- Test: `src/tickets/ticket-asset.service.spec.ts` (ajout describe)

**Interfaces:**
- Consumes: `PrismaService`, `CloudinaryService`, `CloudinaryFolder.TICKETS`, `buildTicketImage`, `buildTicketPdf`.
- Produces:
  - `generateAssetsForOrder(orderId: string): Promise<void>` — best-effort, **ne throw jamais** ; télécharge le design 1× par catégorie, génère et upload PNG+PDF par billet, met à jour `ticketImageUrl`/`pdfUrl`.
  - `TicketsModule` fournissant et exportant `TicketAssetService`.

- [ ] **Step 1: Écrire le test qui échoue**

Ajouter dans `src/tickets/ticket-asset.service.spec.ts` :

```ts
describe('TicketAssetService.generateAssetsForOrder', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  function buildService(overrides: { rawRejectsForTicket?: string } = {}) {
    const prisma = {
      ticket: {
        findMany: jest.fn().mockResolvedValue([
          { id: 't1', qrToken: 'q1', ticketCategoryId: 'c1', ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png' } },
          { id: 't2', qrToken: 'q2', ticketCategoryId: 'c1', ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png' } },
          { id: 't3', qrToken: 'q3', ticketCategoryId: 'c2', ticketCategory: { name: 'Standard', ticketDesignUrl: 'https://d/std.png' } },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const cloudinary = {
      uploadBuffer: jest.fn().mockResolvedValue({ secure_url: 'https://cdn/img.png' }),
      uploadRawBuffer: jest.fn().mockImplementation((_b: Buffer, _f: string, name: string) => {
        if (overrides.rawRejectsForTicket && name.includes(overrides.rawRejectsForTicket)) {
          return Promise.reject(new Error('upload raw KO'));
        }
        return Promise.resolve({ secure_url: 'https://cdn/doc.pdf' });
      }),
    } as any;
    const service = new TicketAssetService(prisma, cloudinary);
    jest.spyOn(service, 'buildTicketImage').mockResolvedValue(Buffer.from('PNG'));
    jest.spyOn(service, 'buildTicketPdf').mockResolvedValue(Buffer.from('%PDF'));
    return { service, prisma, cloudinary };
  }

  it('télécharge le design une seule fois par catégorie et met à jour chaque billet', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    global.fetch = fetchMock as any;
    const { service, prisma } = buildService();

    await service.generateAssetsForOrder('order-1');

    expect(fetchMock).toHaveBeenCalledTimes(2); // 2 catégories, 3 billets
    expect(prisma.ticket.update).toHaveBeenCalledTimes(3);
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { ticketImageUrl: 'https://cdn/img.png', pdfUrl: 'https://cdn/doc.pdf' },
    });
  });

  it('best-effort : l\'échec d\'un billet n\'empêche pas les autres et ne throw pas', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as any;
    const { service, prisma } = buildService({ rawRejectsForTicket: 't1' });

    await expect(service.generateAssetsForOrder('order-1')).resolves.toBeUndefined();
    // t1 échoue avant l'update ; t2 et t3 aboutissent.
    expect(prisma.ticket.update).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts -t "generateAssetsForOrder"`
Expected: FAIL (« generateAssetsForOrder is not a function »).

- [ ] **Step 3: Écrire l'implémentation**

Dans `src/tickets/ticket-asset.service.ts`, ajouter les deux méthodes dans la classe :

```ts
  // Télécharge l'image de design distante (Cloudinary) en buffer.
  private async fetchDesign(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Téléchargement du design échoué (${res.status}) : ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Post-commit best-effort : génère PNG+PDF de chaque billet de la commande et stocke les URLs.
  // Ne throw jamais : un échec laisse le billet avec des URLs null (rattrapé en brique C).
  async generateAssetsForOrder(orderId: string): Promise<void> {
    const tickets = await this.prisma.ticket.findMany({
      where: { orderId },
      include: { ticketCategory: true },
    });

    // Cache de PROMESSES par catégorie : garantit un seul fetch même en parallèle.
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
          const design = await getDesign(t.ticketCategoryId, t.ticketCategory.ticketDesignUrl);
          const png = await this.buildTicketImage(design, t.qrToken, t.ticketCategory.name);
          const imgRes = await this.cloudinary.uploadBuffer(png, CloudinaryFolder.TICKETS);
          const pdf = await this.buildTicketPdf(png);
          const pdfRes = await this.cloudinary.uploadRawBuffer(pdf, CloudinaryFolder.TICKETS, `ticket-${t.id}`);
          await this.prisma.ticket.update({
            where: { id: t.id },
            data: { ticketImageUrl: imgRes.secure_url, pdfUrl: pdfRes.secure_url },
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

- [ ] **Step 4: Créer le module**

`src/tickets/tickets.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CloudinaryModule } from 'src/cloudinary/cloudinary.module';
import { TicketAssetService } from './ticket-asset.service';

@Module({
  imports: [PrismaModule, CloudinaryModule],
  providers: [TicketAssetService],
  exports: [TicketAssetService],
})
export class TicketsModule {}
```

- [ ] **Step 5: Lancer les tests pour vérifier le succès**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts`
Expected: PASS (5 tests au total).

- [ ] **Step 6: Vérifier le build**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 7: Commit**

```bash
git add src/tickets/ticket-asset.service.ts src/tickets/tickets.module.ts src/tickets/ticket-asset.service.spec.ts
git commit -m "feat(tickets): generateAssetsForOrder (best-effort) + TicketsModule"
```

---

### Task 7: Intégration post-commit dans `OrderService`

**Files:**
- Modify: `src/orders/Order.service.ts`
- Modify: `src/orders/Order.module.ts`
- Test: `src/orders/Order.service.spec.ts`

**Interfaces:**
- Consumes: `TicketAssetService.generateAssetsForOrder(orderId)` (Task 6), `TicketsModule` (Task 6).
- Produces: `createOrder` déclenche la génération en post-commit best-effort et renvoie les billets avec `qrToken`, `pdfUrl`, `ticketImageUrl`.

- [ ] **Step 1: Adapter le test existant + ajouter le test de génération**

Dans `src/orders/Order.service.spec.ts` : là où `OrderService` est instancié, injecter un mock du nouveau service. Ajouter/mettre à jour :

```ts
// Mock du service de génération, injecté en 2e argument du constructeur.
const ticketAssets = { generateAssetsForOrder: jest.fn().mockResolvedValue(undefined) };
// ... instanciation : new OrderService(prismaMock as any, ticketAssets as any)

it('déclenche la génération des visuels en post-commit', async () => {
  // arrange : mocks pour un achat valide (cf. tests existants) + prisma.ticket.findMany
  //           renvoyant les billets rechargés.
  // act
  await service.createOrder('user-1', { ticketCategoryId: 'c1', quantity: 1 } as any);
  // assert
  expect(ticketAssets.generateAssetsForOrder).toHaveBeenCalledWith(expect.any(String));
});
```

> Note d'exécution : reprendre exactement le montage de mocks des tests d'achat déjà présents dans ce fichier (catégorie `PUBLISHED`, `purchaseDeadline` future, `$transaction`, `$executeRaw` renvoyant 1). Ajouter au `prismaMock` un `ticket.findMany` renvoyant `[{ qrToken: 'q', pdfUrl: null, ticketImageUrl: null }]` pour le rechargement final.

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/orders/Order.service.spec.ts`
Expected: FAIL (constructeur attend 2 arguments / `generateAssetsForOrder` non appelé).

- [ ] **Step 3: Modifier `OrderService`**

Dans `src/orders/Order.service.ts` :

Imports (ajouter) :

```ts
import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from "@nestjs/common";
import { TicketAssetService } from "src/tickets/ticket-asset.service";
```

Constructeur :

```ts
    private readonly logger = new Logger(OrderService.name);
    constructor(
        private readonly prisma: PrismaService,
        private readonly ticketAssets: TicketAssetService,
    ) {}
```

Remplacer la fin de `createOrder` (le `return this.prisma.$transaction(...)`) par une capture du résultat suivie de la génération post-commit :

```ts
        // Transaction : réservation atomique + order + billets
        const result = await this.prisma.$transaction(async (tx) => {
            const affected = await tx.$executeRaw`
            UPDATE "TicketCategory"
            SET "soldCount" = "soldCount" + ${dto.quantity}
            WHERE "id" = ${dto.ticketCategoryId}
            AND ("totalStock" IS NULL OR "soldCount" + ${dto.quantity} <= "totalStock")`;
            if (affected === 0) throw new ConflictException('Stock insuffisant pour cette quantité.');

            const order = await tx.order.create({
                data: {
                    userId,
                    ticketCategoryId: dto.ticketCategoryId,
                    quantity: dto.quantity,
                    unitPrice, totalAmount, platformFee, organizerAmount,
                    paymentStatus: 'PAID', // stub — la brique B posera le vrai PENDING→PAID
                },
            });

            const tickets = Array.from({ length: dto.quantity }, () => ({
                orderId: order.id,
                ticketCategoryId: dto.ticketCategoryId,
                qrToken: randomUUID(),
                expiresAt: event.endDate,
            }));
            await tx.ticket.createMany({ data: tickets });

            return order;
        });

        // Post-commit best-effort : la génération ne doit jamais faire échouer l'achat.
        try {
            await this.ticketAssets.generateAssetsForOrder(result.id);
        } catch (e) {
            this.logger.error(`Génération des visuels échouée (order ${result.id}) : ${e instanceof Error ? e.stack : String(e)}`);
        }

        // Recharger les billets avec leurs URLs (remplies, ou null si génération échouée).
        const tickets = await this.prisma.ticket.findMany({
            where: { orderId: result.id },
            select: { qrToken: true, pdfUrl: true, ticketImageUrl: true },
        });

        return { order: result, tickets };
```

- [ ] **Step 4: Câbler le module**

Dans `src/orders/Order.module.ts`, ajouter l'import de `TicketsModule` :

```ts
import { TicketsModule } from "src/tickets/tickets.module";
// ...
    imports: [PrismaModule, AuthModule, TicketsModule],
```

- [ ] **Step 5: Lancer les tests pour vérifier le succès**

Run: `npx jest src/orders/Order.service.spec.ts`
Expected: PASS (tests d'achat existants + nouveau test de génération).

- [ ] **Step 6: Suite complète + build**

Run: `npm run test && npm run build`
Expected: toute la suite verte, build OK.

- [ ] **Step 7: Commit**

```bash
git add src/orders/Order.service.ts src/orders/Order.module.ts src/orders/Order.service.spec.ts
git commit -m "feat(orders): génération post-commit des visuels de billet (brique D)"
```

---

## Self-Review

**Spec coverage :**
- Champ `Ticket.ticketImageUrl` → Task 1. ✅
- Palette déterministe par nom → Task 2. ✅
- Upload PDF (resource_type raw) → Task 3. ✅
- Bandeau QR sous le design + ruban haut-droit coloré + QR = qrToken brut → Task 4. ✅
- PDF bord à bord → Task 5. ✅
- Post-commit best-effort, download 1×/catégorie, rattrapage brique C (réutilisation du service) → Task 6. ✅
- Intégration `OrderService` hors transaction → Task 7. ✅
- Dépendances `sharp`/`pdfkit`/`@types/pdfkit` → installées Tasks 4 & 5. ✅

**Placeholders :** aucun « TODO/TBD » ; tout le code est concret. Les valeurs de géométrie du ruban (facteurs 0.3/0.42/0.65) sont des valeurs réelles à ajuster visuellement uniquement si besoin esthétique.

**Type consistency :** `buildTicketImage`, `buildTicketPdf`, `generateAssetsForOrder`, `uploadRawBuffer`, `colorForCategoryName`, `TICKET_PALETTE`, `BAND_HEIGHT`/`QR_SIZE` (statiques) — noms identiques entre définition et usages. `generateAssetsForOrder(orderId: string)` appelé avec `result.id` (Task 7) cohérent.

## Hors périmètre (rappel)

Brique C (`GET /me/tickets`, rattrapage), Brique E (dashboard scans), Brique B (paiement réel), Brique F (purges cron).
