# Brique D — Génération des visuels du billet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Après un achat, générer pour chaque billet une carte PNG (image de design + titre/catégorie de l'événement + bandeau Date/Heure/Place + QR) et un PDF, les héberger sur Cloudinary et stocker leurs URLs sur le `Ticket`.

**Architecture:** Un module dédié `src/tickets/` porte un `TicketAssetService` : formatage des libellés, rendu d'un gabarit SVG de largeur fixe (image + QR embarqués) rasterisé en PNG via `sharp`, PDF via `pdfkit`, upload Cloudinary, update Prisma. `OrderService` l'appelle en post-commit best-effort (hors transaction).

**Tech Stack:** NestJS · Prisma · `qrcode` (déjà installé) · `sharp` · `pdfkit` · Cloudinary.

## Global Constraints

- Node 20, projet CommonJS. `fetch` global disponible (pas d'import).
- Tests : Jest, fichiers `*.spec.ts`, `rootDir: src`, alias `^src/(.*)$` → `<rootDir>/$1`. Lancer un fichier : `npx jest src/chemin/fichier.spec.ts`.
- Commentaires et messages en **français**. **Pas** de `Co-Authored-By` dans les commits.
- Le QR encode le `qrToken` **brut** (UUID v4, texte nu) — imposé par `ScanDto @IsUUID('4')`.
- **Aucune couleur dérivée / palette** : la seule source de couleur est l'image de design de l'organisateur.
- Pied de page : « QR à usage unique » **uniquement** (jamais `Event.reference`).
- Best-effort : la génération **ne doit jamais** faire échouer `POST /orders`.
- `CloudinaryFolder.TICKETS` (`'vybe/tickets'`) existe déjà — l'utiliser.
- Toute valeur texte issue des données est **échappée XML** avant insertion dans le SVG.

---

## File Structure

- `prisma/schema.prisma` — `Ticket.ticketImageUrl String?` (**déjà migré**, Task 1).
- `src/tickets/ticket-asset.service.ts` — `TicketAssetService` (+ type `TicketFields`).
- `src/tickets/ticket-asset.service.spec.ts` — tests service.
- `src/tickets/tickets.module.ts` — module (importe `CloudinaryModule`+`PrismaModule`, exporte le service).
- `src/cloudinary/cloudinary.service.ts` — ajout `uploadRawBuffer()`.
- `src/cloudinary/cloudinary.service.spec.ts` — test `uploadRawBuffer` (nouveau).
- `src/orders/Order.service.ts` — intégration post-commit.
- `src/orders/Order.service.spec.ts` — adapter (mock du nouveau service).
- `src/orders/Order.module.ts` — importer `TicketsModule`.

---

### Task 1: Migration Prisma — `Ticket.ticketImageUrl` ✅ FAIT

Migration `add_ticket_image_url` appliquée ; champ `ticketImageUrl String?` présent sur `Ticket`.

---

### Task 2: `CloudinaryService.uploadRawBuffer` (upload PDF depuis un buffer)

**Files:**
- Modify: `src/cloudinary/cloudinary.service.ts`
- Test: `src/cloudinary/cloudinary.service.spec.ts` (nouveau)

**Interfaces:**
- Produces: `uploadRawBuffer(buffer: Buffer, folder: string, filename: string): Promise<UploadApiResponse>` — `resource_type: 'raw'`, `format: 'pdf'`, `public_id: filename`.

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

- [ ] **Step 2: Vérifier l'échec**

Run: `npx jest src/cloudinary/cloudinary.service.spec.ts`
Expected: FAIL (« uploadRawBuffer is not a function »).

- [ ] **Step 3: Implémenter** — dans `src/cloudinary/cloudinary.service.ts`, ajouter dans la classe (à côté de `uploadBuffer`) :

```ts
  // Upload d'un PDF généré côté serveur (billet). resource_type 'raw' : stocké tel quel.
  async uploadRawBuffer(
    buffer: Buffer,
    folder: string,
    filename: string,
  ): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const upload = cloudinary.uploader.upload_stream(
        { folder, resource_type: 'raw', public_id: filename, format: 'pdf' },
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

- [ ] **Step 4: Vérifier le succès**

Run: `npx jest src/cloudinary/cloudinary.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cloudinary/cloudinary.service.ts src/cloudinary/cloudinary.service.spec.ts
git commit -m "feat(cloudinary): uploadRawBuffer pour héberger un PDF généré"
```

---

### Task 3: `TicketAssetService.buildTicketImage` (rendu de la carte)

**Files:**
- Create: `src/tickets/ticket-asset.service.ts`
- Test: `src/tickets/ticket-asset.service.spec.ts`

**Setup:** `npm i sharp` (`qrcode` déjà installé).

**Interfaces:**
- Produces:
  - `export type TicketFields = { qrToken: string; eventCategory: string; eventTitle: string; dateLabel: string; timeLabel: string; placeLabel: string; }`
  - `buildTicketImage(designBuffer: Buffer, fields: TicketFields): Promise<Buffer>` — PNG de **dimensions fixes** (largeur 750, hauteur 1040), en-tête = design recadré cover + catégorie/titre, bandeau Date/Heure/Place, QR (= `qrToken` brut), pied « QR à usage unique ».

- [ ] **Step 1: Installer sharp**

Run: `npm i sharp`
Expected: installé sans erreur.

- [ ] **Step 2: Écrire le test qui échoue**

`src/tickets/ticket-asset.service.spec.ts` :

```ts
import sharp from 'sharp';
import * as QRCode from 'qrcode';
import { TicketAssetService, TicketFields } from './ticket-asset.service';

async function makeDesign(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#334155' } }).png().toBuffer();
}

const baseFields: TicketFields = {
  qrToken: '11111111-1111-4111-8111-111111111111',
  eventCategory: 'FESTIVAL',
  eventTitle: 'Neon Nights',
  dateLabel: 'Ven. 27 juin',
  timeLabel: '22:00',
  placeLabel: 'Standard',
};

describe('TicketAssetService.buildTicketImage', () => {
  const service = new TicketAssetService({} as any, {} as any);

  it('rend une carte PNG de dimensions fixes quelle que soit la taille du design', async () => {
    const png = await service.buildTicketImage(await makeDesign(1200, 400), baseFields);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(750);
    expect(meta.height).toBe(1040);
  });

  it('encode le qrToken brut dans le QR', async () => {
    const spy = jest.spyOn(QRCode, 'toBuffer');
    await service.buildTicketImage(await makeDesign(400, 400), baseFields);
    expect(spy.mock.calls[0][0]).toBe(baseFields.qrToken);
    spy.mockRestore();
  });

  it('échappe les valeurs texte sans casser le rendu', async () => {
    const png = await service.buildTicketImage(await makeDesign(400, 400), {
      ...baseFields, eventTitle: 'Rock & <Roll>',
    });
    expect(Buffer.isBuffer(png)).toBe(true);
  });
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts`
Expected: FAIL (« Cannot find module './ticket-asset.service' »).

- [ ] **Step 4: Implémenter** — `src/tickets/ticket-asset.service.ts` :

```ts
import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import * as QRCode from 'qrcode';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';

export type TicketFields = {
  qrToken: string;
  eventCategory: string; // Event.category, ex. "FESTIVAL"
  eventTitle: string;    // Event.title, ex. "Neon Nights"
  dateLabel: string;     // ex. "Ven. 27 juin"
  timeLabel: string;     // ex. "22:00"
  placeLabel: string;    // TicketCategory.name, ex. "Standard"
};

// Échappe une valeur (saisie utilisateur) avant insertion dans le SVG.
function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string),
  );
}

@Injectable()
export class TicketAssetService {
  private readonly logger = new Logger(TicketAssetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // Rend la carte du billet (PNG, 750x1040).
  async buildTicketImage(designBuffer: Buffer, fields: TicketFields): Promise<Buffer> {
    const W = 750;
    const HEADER_H = 300;
    const H = 1040;

    // 1) En-tête : image de design recadrée cover.
    const header = await sharp(designBuffer)
      .resize({ width: W, height: HEADER_H, fit: 'cover' })
      .png()
      .toBuffer();
    const headerB64 = `data:image/png;base64,${header.toString('base64')}`;

    // 2) QR à partir du qrToken brut.
    const qrPng = await QRCode.toBuffer(fields.qrToken, {
      width: 360, margin: 1, errorCorrectionLevel: 'M',
    });
    const qrB64 = `data:image/png;base64,${qrPng.toString('base64')}`;

    const cat = escapeXml(fields.eventCategory);
    const title = escapeXml(fields.eventTitle);
    const date = escapeXml(fields.dateLabel);
    const time = escapeXml(fields.timeLabel);
    const place = escapeXml(fields.placeLabel);

    // 3) Gabarit SVG (image + QR embarqués).
    const svg = `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
      <defs>
        <clipPath id="card"><rect x="0" y="0" width="${W}" height="${H}" rx="28" ry="28"/></clipPath>
        <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#000000" stop-opacity="0"/>
          <stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
        </linearGradient>
      </defs>
      <g clip-path="url(#card)" font-family="Helvetica, Arial, sans-serif">
        <rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>
        <image xlink:href="${headerB64}" x="0" y="0" width="${W}" height="${HEADER_H}"/>
        <rect x="0" y="140" width="${W}" height="160" fill="url(#shade)"/>
        <text x="40" y="232" fill="#ffffff" fill-opacity="0.85" font-size="20" font-weight="bold" letter-spacing="3">${cat}</text>
        <text x="40" y="280" fill="#ffffff" font-size="44" font-weight="bold">${title}</text>

        <text x="40"  y="356" fill="#94a3b8" font-size="18" font-weight="bold" letter-spacing="2">DATE</text>
        <text x="40"  y="392" fill="#0f172a" font-size="26" font-weight="bold">${date}</text>
        <line x1="262" y1="336" x2="262" y2="404" stroke="#e2e8f0" stroke-width="2"/>
        <text x="288" y="356" fill="#94a3b8" font-size="18" font-weight="bold" letter-spacing="2">HEURE</text>
        <text x="288" y="392" fill="#0f172a" font-size="26" font-weight="bold">${time}</text>
        <line x1="500" y1="336" x2="500" y2="404" stroke="#e2e8f0" stroke-width="2"/>
        <text x="526" y="356" fill="#94a3b8" font-size="18" font-weight="bold" letter-spacing="2">PLACE</text>
        <text x="526" y="392" fill="#0f172a" font-size="26" font-weight="bold">${place}</text>

        <line x1="40" y1="460" x2="710" y2="460" stroke="#cbd5e1" stroke-width="3" stroke-dasharray="2 12" stroke-linecap="round"/>

        <rect x="155" y="500" width="440" height="440" rx="32" fill="#ffffff" stroke="#eef2f7" stroke-width="2"/>
        <image xlink:href="${qrB64}" x="195" y="540" width="360" height="360"/>

        <g transform="translate(250,976)">
          <rect x="0" y="7" width="15" height="12" rx="2" fill="#db2777"/>
          <path d="M3 7 V4.5 A4.5 4.5 0 0 1 12 4.5 V7" fill="none" stroke="#db2777" stroke-width="2"/>
        </g>
        <text x="392" y="990" text-anchor="middle" fill="#64748b" font-size="22">QR à usage unique</text>
      </g>
    </svg>`;

    // 4) Rasterisation.
    return sharp(Buffer.from(svg)).png().toBuffer();
  }
}
```

> Note : on utilise `xlink:href` pour les `<image>` (compatibilité maximale avec le rendu SVG de `sharp`/librsvg). Les valeurs de géométrie (positions, tailles) sont réelles et n'ont besoin d'être ajustées que pour un raffinement esthétique.

- [ ] **Step 5: Vérifier le succès**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/tickets/ticket-asset.service.ts src/tickets/ticket-asset.service.spec.ts
git commit -m "feat(tickets): rendu de la carte du billet (image + infos + QR)"
```

---

### Task 4: `TicketAssetService.buildTicketPdf` (pdfkit)

**Files:**
- Modify: `src/tickets/ticket-asset.service.ts`
- Test: `src/tickets/ticket-asset.service.spec.ts` (ajout describe)

**Setup:** `npm i pdfkit && npm i -D @types/pdfkit`.

**Interfaces:**
- Produces: `buildTicketPdf(pngBuffer: Buffer): Promise<Buffer>` — PDF mono-page dimensionné au PNG, image bord à bord. Buffer commençant par `%PDF`.

- [ ] **Step 1: Installer pdfkit**

Run: `npm i pdfkit && npm i -D @types/pdfkit`
Expected: installés sans erreur.

- [ ] **Step 2: Écrire le test qui échoue** — ajouter dans le spec :

```ts
describe('TicketAssetService.buildTicketPdf', () => {
  const service = new TicketAssetService({} as any, {} as any);

  it('renvoie un buffer PDF (magic %PDF)', async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#000000' } }).png().toBuffer();
    const pdf = await service.buildTicketPdf(png);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
```

- [ ] **Step 3: Vérifier l'échec**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts -t "buildTicketPdf"`
Expected: FAIL (« buildTicketPdf is not a function »).

- [ ] **Step 4: Implémenter** — en haut du fichier, ajouter l'import :

```ts
import PDFDocument from 'pdfkit';
```

Puis dans la classe :

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

- [ ] **Step 5: Vérifier le succès**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts`
Expected: PASS (4 tests au total).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/tickets/ticket-asset.service.ts src/tickets/ticket-asset.service.spec.ts
git commit -m "feat(tickets): génération du PDF du billet à partir du PNG"
```

---

### Task 5: `generateAssetsForOrder` (orchestration + formatage) + `TicketsModule`

**Files:**
- Modify: `src/tickets/ticket-asset.service.ts`
- Create: `src/tickets/tickets.module.ts`
- Test: `src/tickets/ticket-asset.service.spec.ts` (ajout describe)

**Interfaces:**
- Produces:
  - `generateAssetsForOrder(orderId: string): Promise<void>` — best-effort, **ne throw jamais** ; télécharge le design 1× par catégorie, formate les libellés depuis l'`Event`, génère+upload PNG+PDF par billet, met à jour `ticketImageUrl`/`pdfUrl`.
  - `TicketsModule` (fournit + exporte `TicketAssetService`).

- [ ] **Step 1: Écrire le test qui échoue** — ajouter dans le spec :

```ts
describe('TicketAssetService.generateAssetsForOrder', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const evt = { category: 'FESTIVAL', title: 'Neon Nights', startDate: new Date('2026-06-27T22:00:00') };

  function buildService(overrides: { rawRejectsForTicket?: string } = {}) {
    const prisma = {
      ticket: {
        findMany: jest.fn().mockResolvedValue([
          { id: 't1', qrToken: 'q1', ticketCategoryId: 'c1', ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png', event: evt } },
          { id: 't2', qrToken: 'q2', ticketCategoryId: 'c1', ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png', event: evt } },
          { id: 't3', qrToken: 'q3', ticketCategoryId: 'c2', ticketCategory: { name: 'Standard', ticketDesignUrl: 'https://d/std.png', event: evt } },
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
    return { service, prisma };
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
    expect(prisma.ticket.update).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts -t "generateAssetsForOrder"`
Expected: FAIL (« generateAssetsForOrder is not a function »).

- [ ] **Step 3: Implémenter** — ajouter les imports en haut du fichier :

```ts
import { CloudinaryFolder } from 'src/cloudinary/cloudinary.folder';
```

Puis dans la classe, les helpers de formatage et l'orchestration :

```ts
  private dateLabel(d: Date): string {
    const s = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'long' });
    return s.charAt(0).toUpperCase() + s.slice(1); // "ven. 27 juin" -> "Ven. 27 juin"
  }

  private timeLabel(d: Date): string {
    return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  private async fetchDesign(url: string): Promise<Buffer> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Téléchargement du design échoué (${res.status}) : ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Post-commit best-effort : génère PNG+PDF de chaque billet et stocke les URLs.
  // Ne throw jamais : un échec laisse le billet avec des URLs null (rattrapé en brique C).
  async generateAssetsForOrder(orderId: string): Promise<void> {
    const tickets = await this.prisma.ticket.findMany({
      where: { orderId },
      include: { ticketCategory: { include: { event: true } } },
    });

    // Cache de PROMESSES par catégorie : un seul fetch même en parallèle.
    const designCache = new Map<string, Promise<Buffer>>();
    const getDesign = (categoryId: string, url: string): Promise<Buffer> => {
      let p = designCache.get(categoryId);
      if (!p) { p = this.fetchDesign(url); designCache.set(categoryId, p); }
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

- [ ] **Step 4: Créer le module** — `src/tickets/tickets.module.ts` :

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

- [ ] **Step 5: Vérifier le succès + build**

Run: `npx jest src/tickets/ticket-asset.service.spec.ts && npm run build`
Expected: PASS (6 tests) + build OK.

- [ ] **Step 6: Commit**

```bash
git add src/tickets/ticket-asset.service.ts src/tickets/tickets.module.ts src/tickets/ticket-asset.service.spec.ts
git commit -m "feat(tickets): generateAssetsForOrder (best-effort) + TicketsModule"
```

---

### Task 6: Intégration post-commit dans `OrderService`

**Files:**
- Modify: `src/orders/Order.service.ts`
- Modify: `src/orders/Order.module.ts`
- Test: `src/orders/Order.service.spec.ts`

**Interfaces:**
- Consumes: `TicketAssetService.generateAssetsForOrder(orderId)`, `TicketsModule`.
- Produces: `createOrder` déclenche la génération post-commit best-effort et renvoie les billets avec `qrToken`, `pdfUrl`, `ticketImageUrl`.

- [ ] **Step 1: Adapter le spec existant + test de génération**

Dans `src/orders/Order.service.spec.ts` : injecter un mock du service en 2e argument du constructeur, et ajouter :

```ts
const ticketAssets = { generateAssetsForOrder: jest.fn().mockResolvedValue(undefined) };
// instanciation : new OrderService(prismaMock as any, ticketAssets as any)

it('déclenche la génération des visuels en post-commit', async () => {
  // reprendre le montage des tests d'achat valides déjà présents (catégorie PUBLISHED,
  // purchaseDeadline future, $transaction, $executeRaw -> 1), et ajouter au prismaMock :
  //   ticket.findMany -> [{ qrToken: 'q', pdfUrl: null, ticketImageUrl: null }]
  await service.createOrder('user-1', { ticketCategoryId: 'c1', quantity: 1 } as any);
  expect(ticketAssets.generateAssetsForOrder).toHaveBeenCalledWith(expect.any(String));
});
```

- [ ] **Step 2: Vérifier l'échec**

Run: `npx jest src/orders/Order.service.spec.ts`
Expected: FAIL (constructeur attend 2 arguments / génération non appelée).

- [ ] **Step 3: Modifier `OrderService`** — imports :

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

Remplacer le `return this.prisma.$transaction(...)` final par (la transaction renvoie l'`order`) :

```ts
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
                    paymentStatus: 'PAID',
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

        // Post-commit best-effort : ne doit jamais faire échouer l'achat.
        try {
            await this.ticketAssets.generateAssetsForOrder(result.id);
        } catch (e) {
            this.logger.error(`Génération des visuels échouée (order ${result.id}) : ${e instanceof Error ? e.stack : String(e)}`);
        }

        const tickets = await this.prisma.ticket.findMany({
            where: { orderId: result.id },
            select: { qrToken: true, pdfUrl: true, ticketImageUrl: true },
        });

        return { order: result, tickets };
```

- [ ] **Step 4: Câbler le module** — dans `src/orders/Order.module.ts` :

```ts
import { TicketsModule } from "src/tickets/tickets.module";
// ...
    imports: [PrismaModule, AuthModule, TicketsModule],
```

- [ ] **Step 5: Vérifier le succès**

Run: `npx jest src/orders/Order.service.spec.ts`
Expected: PASS.

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
- Champ `Ticket.ticketImageUrl` → Task 1 (fait). ✅
- Upload PDF (resource_type raw) → Task 2. ✅
- Carte : image cover + catégorie/titre en overlay + bandeau Date/Heure/Place + QR (qrToken brut) + « QR à usage unique » sans référence → Task 3. ✅
- PDF bord à bord → Task 4. ✅
- Post-commit best-effort, download 1×/catégorie, formatage des libellés depuis l'Event, rattrapage brique C → Task 5. ✅
- Intégration `OrderService` hors transaction → Task 6. ✅
- Aucune couleur/palette/ruban. ✅

**Placeholders :** aucun « TODO/TBD » ; code concret. Valeurs de géométrie SVG = valeurs réelles.

**Type consistency :** `TicketFields`, `buildTicketImage`, `buildTicketPdf`, `generateAssetsForOrder`, `uploadRawBuffer` — noms cohérents entre définition et usages. `generateAssetsForOrder(orderId: string)` appelé avec `result.id` (Task 6). Include `ticketCategory: { include: { event: true } }` cohérent avec l'accès `t.ticketCategory.event`.

## Hors périmètre (rappel)

Brique C (`GET /me/tickets`, rattrapage), Brique E (dashboard scans), Brique B (paiement réel), Brique F (purges cron).
