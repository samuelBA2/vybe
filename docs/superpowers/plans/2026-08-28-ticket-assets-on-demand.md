# Assets billet à la volée — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supprimer tout asset stocké par billet : le billet devient un token + un rendu client-side (QR) + un download serveur streamé à la demande, sans Cloudinary par billet.

**Architecture:** Deux endpoints propriétaires additifs (`qr-token`, `download`) réutilisant les helpers sharp existants ; bascule du frontend vers un rendu client-side (design Cloudinary transformé + QR `qrcode.react` + fallback offline) ; puis retrait de la génération eager, de la purge Cloudinary par billet, et des colonnes `ticketImageUrl`/`pdfUrl`.

**Tech Stack:** Backend NestJS + Prisma + Jest (`/Users/user/vybe`). Frontend React + Vite + Vitest + TanStack Query + `qrcode.react` (`/Users/user/vybeFrontend`).

## Global Constraints

- Le `qrToken` n'est exposé **que** par `GET /me/tickets/:id/qr-token`, jamais en liste. Règle « jamais le qrToken brut dans `/me/tickets` » conservée.
- **Ownership en une requête jointe** `Ticket → Order.userId` ; non-propriétaire → **404** (`NotFoundException`), jamais 403.
- Aucun upload Cloudinary par billet (ni à l'achat, ni au download). Cloudinary ne garde que `ticketDesignUrl` (design catégorie).
- Rendu PNG/PDF du download = mêmes helpers `buildTicketImage`/`buildTicketPdf` (aucune régression visuelle).
- Messages/commentaires en **français**.
- **Ordre d'exécution impératif** : Tâches 1→3 (backend additif) → 4→5 (bascule frontend) → 6→9 (retraits backend). Ne pas dropper les colonnes avant que le front ait basculé.
- Repos : backend `/Users/user/vybe` (`npx jest`), frontend `/Users/user/vybeFrontend` (`npx vitest run`, `npx tsc --noEmit`, `npm run lint`, `npm run build`).

---

### Task 1 : Endpoint `GET /me/tickets/:id/qr-token`

**Files:**
- Modify: `src/orders/MyTickets.service.ts` (méthode `getQrToken`)
- Modify: `src/orders/MyTickets.controller.ts` (route)
- Test: `src/orders/MyTickets.service.spec.ts`

**Interfaces:**
- Produces: `MyTicketsService.getQrToken(userId: string, ticketId: string): Promise<{ qrToken: string }>` ; route `GET /me/tickets/:id/qr-token`.

- [ ] **Step 1 : Test qui échoue**

Ajouter dans `src/orders/MyTickets.service.spec.ts` :

```ts
describe('getQrToken', () => {
  it('propriétaire → renvoie le token (requête jointe Ticket→Order.userId)', async () => {
    prisma.ticket.findFirst.mockResolvedValue({ qrToken: 'tok-123' });
    const res = await service.getQrToken('user-1', 't1');
    expect(res).toEqual({ qrToken: 'tok-123' });
    expect(prisma.ticket.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', order: { userId: 'user-1' } },
      select: { qrToken: true },
    });
  });

  it('non-propriétaire (findFirst null) → 404, pas 403', async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);
    await expect(service.getQrToken('intrus', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```

Assurer l'import `NotFoundException` depuis `@nestjs/common` et que le mock `prisma.ticket` expose `findFirst: jest.fn()` (l'ajouter au fake prisma du fichier s'il manque).

- [ ] **Step 2 : Vérifier l'échec**

Run: `cd /Users/user/vybe && npx jest src/orders/MyTickets.service.spec.ts -t "getQrToken"`
Expected: FAIL — `getQrToken` n'existe pas.

- [ ] **Step 3 : Implémenter le service**

Dans `src/orders/MyTickets.service.ts`, ajouter l'import `NotFoundException` à la ligne `import { Injectable } from '@nestjs/common';` → `import { Injectable, NotFoundException } from '@nestjs/common';`, puis la méthode :

```ts
  // Token brut du billet, réservé à son propriétaire. Requête jointe unique
  // (Ticket→Order.userId) ; non-propriétaire → 404 (aucune fuite d'existence).
  async getQrToken(userId: string, ticketId: string): Promise<{ qrToken: string }> {
    const ticket = await this.prisma.ticket.findFirst({
      where: { id: ticketId, order: { userId } },
      select: { qrToken: true },
    });
    if (!ticket) throw new NotFoundException('Billet introuvable.');
    return { qrToken: ticket.qrToken };
  }
```

- [ ] **Step 4 : Route**

Dans `src/orders/MyTickets.controller.ts`, ajouter `Param` à l'import `@nestjs/common` (`import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';`) et la route :

```ts
  // GET /me/tickets/:id/qr-token — token du billet (propriétaire uniquement).
  @Get('tickets/:id/qr-token')
  async qrToken(@Req() req, @Param('id') id: string) {
    return this.myTicketsService.getQrToken(req.user.sub, id);
  }
```

- [ ] **Step 5 : Vérifier le succès**

Run: `cd /Users/user/vybe && npx jest src/orders/MyTickets.service.spec.ts`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
cd /Users/user/vybe
git add src/orders/MyTickets.service.ts src/orders/MyTickets.controller.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(tickets): endpoint GET /me/tickets/:id/qr-token (propriétaire, 404 sinon)"
```

---

### Task 2 : `MyTickets` — ajouter `ticketDesignUrl` (additif)

**Files:**
- Modify: `src/orders/dto/MyTickets.dto.ts`
- Modify: `src/orders/MyTickets.service.ts` (select + map)
- Test: `src/orders/MyTickets.service.spec.ts`

**Interfaces:**
- Produces: `MyTicketDto` gagne `ticketDesignUrl: string`. `ticketImageUrl`/`pdfUrl` restent pour l'instant (retirés en Tâche 8).

- [ ] **Step 1 : Test (RED)**

Dans `src/orders/MyTickets.service.spec.ts`, dans le test qui vérifie le mapping d'un billet, ajouter une assertion `ticketDesignUrl`. Le fake row (`row(...)`) doit fournir `ticketCategory.ticketDesignUrl`. Ajouter au helper `row` la valeur `ticketDesignUrl: 'design-url'` dans `ticketCategory`, et asserter :
```ts
expect(res.upcoming[0].tickets[0].ticketDesignUrl).toBe('design-url');
```

- [ ] **Step 2 : Échec**

Run: `cd /Users/user/vybe && npx jest src/orders/MyTickets.service.spec.ts`
Expected: FAIL (champ absent / type).

- [ ] **Step 3 : DTO**

Dans `src/orders/dto/MyTickets.dto.ts`, ajouter dans `MyTicketDto` :
```ts
  ticketDesignUrl: string; // design de la catégorie (fond du billet, rendu client-side)
```

- [ ] **Step 4 : Service (select + map)**

Dans `src/orders/MyTickets.service.ts` `fetchRows`, ajouter `ticketDesignUrl: true` au `select` de `ticketCategory` (à côté de `name`) :
```ts
        ticketCategory: {
        select: {
            name: true,
            ticketDesignUrl: true,
            event: { /* inchangé */ },
        },
        },
```
Dans `groupByEvent`, au `entry.tickets.push`, ajouter :
```ts
        ticketDesignUrl: t.ticketCategory.ticketDesignUrl,
```

- [ ] **Step 5 : Succès**

Run: `cd /Users/user/vybe && npx jest src/orders/MyTickets.service.spec.ts`
Expected: PASS.

- [ ] **Step 6 : Commit**

```bash
cd /Users/user/vybe
git add src/orders/dto/MyTickets.dto.ts src/orders/MyTickets.service.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(tickets): expose ticketDesignUrl dans /me/tickets (rendu client-side)"
```

---

### Task 3 : Endpoint `GET /me/tickets/:id/download` + méthodes de rendu

**Files:**
- Modify: `src/ticket-asset/ticket-asset.service.ts` (méthodes `renderTicketPng`/`renderTicketPdf` + fallback design)
- Modify: `src/orders/MyTickets.service.ts` (`getTicketForRender`)
- Modify: `src/orders/MyTickets.controller.ts` (route download + injection `TicketAssetService`)
- Modify: `src/orders/orders.module.ts` (importer le module fournissant `TicketAssetService`, s'il ne l'est pas déjà)
- Test: `src/orders/MyTickets.service.spec.ts`, `src/ticket-asset/ticket-asset.service.spec.ts`

**Interfaces:**
- Produces:
  - `TicketAssetService.renderTicketPng(input: RenderInput): Promise<Buffer>` et `renderTicketPdf(input: RenderInput): Promise<Buffer>`, avec `RenderInput = { qrToken; eventTitle; eventCategory; startDate: Date; categoryName; designUrl }`.
  - `MyTicketsService.getTicketForRender(userId, ticketId)` → données jointes (404 sinon).
  - Route `GET /me/tickets/:id/download?format=png|pdf`.

- [ ] **Step 1 : Tests (RED)**

Dans `src/orders/MyTickets.service.spec.ts` :
```ts
describe('getTicketForRender', () => {
  it('non-propriétaire → 404', async () => {
    prisma.ticket.findFirst.mockResolvedValue(null);
    await expect(service.getTicketForRender('intrus', 't1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
```
Dans `src/ticket-asset/ticket-asset.service.spec.ts`, ajouter un test qui vérifie que `renderTicketPng` utilise le **fond neutre** si le fetch design échoue (mock `fetch` global qui rejette / `res.ok=false`) et renvoie bien un Buffer PNG non vide. (S'appuyer sur le mock `QRCode.toBuffer` déjà présent dans ce spec.)

- [ ] **Step 2 : Échec**

Run: `cd /Users/user/vybe && npx jest src/orders/MyTickets.service.spec.ts src/ticket-asset/ticket-asset.service.spec.ts`
Expected: FAIL (méthodes absentes).

- [ ] **Step 3 : Méthodes de rendu (ticket-asset.service.ts)**

Dans `src/ticket-asset/ticket-asset.service.ts`, ajouter (près de `buildTicketPdf`) le type et les méthodes :

```ts
  // Entrée de rendu à la demande (pas de dépendance Prisma ici).
  // (déclarer ce type au niveau module, à côté de TicketFields)
```
Au niveau module (à côté de `TicketFields`, ~ligne 17) :
```ts
export type RenderInput = {
    qrToken: string;
    eventTitle: string;
    eventCategory: string;
    startDate: Date;
    categoryName: string;
    designUrl: string;
};
```
Dans la classe :
```ts
    // Fond neutre brandé si le design est injoignable (P4).
    private async neutralBackground(width: number, height: number): Promise<Buffer> {
        return sharp({ create: { width, height, channels: 3, background: '#0b0b12' } }).png().toBuffer();
    }

    private async fetchDesignOrFallback(url: string): Promise<Buffer> {
        try {
            return await this.fetchDesign(url);
        } catch (e) {
            this.logger.warn(`Design injoignable, fond neutre utilisé : ${e instanceof Error ? e.message : String(e)}`);
            return this.neutralBackground(750, 300); // dimensions de l'en-tête cover
        }
    }

    // Compose le PNG du billet à la demande (design + QR), sans upload.
    async renderTicketPng(input: RenderInput): Promise<Buffer> {
        const fields: TicketFields = {
            qrToken: input.qrToken,
            eventCategory: input.eventCategory,
            eventTitle: input.eventTitle,
            dateLabel: this.dateLabel(input.startDate),
            timeLabel: this.timeLabel(input.startDate),
            placeLabel: input.categoryName,
        };
        const design = await this.fetchDesignOrFallback(input.designUrl);
        return this.buildTicketImage(design, fields);
    }

    async renderTicketPdf(input: RenderInput): Promise<Buffer> {
        return this.buildTicketPdf(await this.renderTicketPng(input));
    }
```

- [ ] **Step 4 : Résolveur d'ownership (MyTickets.service.ts)**

```ts
  // Données jointes pour composer le billet à la demande. 404 si non-propriétaire.
  async getTicketForRender(userId: string, ticketId: string) {
    const t = await this.prisma.ticket.findFirst({
      where: { id: ticketId, order: { userId } },
      select: {
        qrToken: true,
        ticketCategory: {
          select: {
            name: true,
            ticketDesignUrl: true,
            event: { select: { title: true, category: true, startDate: true } },
          },
        },
      },
    });
    if (!t) throw new NotFoundException('Billet introuvable.');
    return t;
  }
```

- [ ] **Step 5 : Route download (controller)**

Dans `src/orders/MyTickets.controller.ts` : injecter `TicketAssetService`, importer `Query`, `Res`, `BadRequestException` de `@nestjs/common` et `Response` d'`express`. Constructeur :
```ts
  constructor(
    private readonly myTicketsService: MyTicketsService,
    private readonly ticketAssets: TicketAssetService,
  ) {}
```
Route :
```ts
  // GET /me/tickets/:id/download?format=png|pdf — fichier composé à la demande, jamais stocké.
  @Get('tickets/:id/download')
  async download(
    @Req() req,
    @Param('id') id: string,
    @Query('format') format: string,
    @Res() res: Response,
  ) {
    const wantsPdf = format === 'pdf';
    if (format && format !== 'pdf' && format !== 'png') {
      throw new BadRequestException("Format invalide (png|pdf).");
    }
    const etag = `"${id}-${wantsPdf ? 'pdf' : 'png'}"`;
    if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }

    const t = await this.myTicketsService.getTicketForRender(req.user.sub, id);
    const input = {
      qrToken: t.qrToken,
      eventTitle: t.ticketCategory.event.title,
      eventCategory: t.ticketCategory.event.category,
      startDate: t.ticketCategory.event.startDate,
      categoryName: t.ticketCategory.name,
      designUrl: t.ticketCategory.ticketDesignUrl,
    };
    const buffer = wantsPdf
      ? await this.ticketAssets.renderTicketPdf(input)
      : await this.ticketAssets.renderTicketPng(input);

    const safe = `${t.ticketCategory.event.title}-${t.ticketCategory.name}`.replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', wantsPdf ? 'application/pdf' : 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="billet-${safe}.${wantsPdf ? 'pdf' : 'png'}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    res.end(buffer);
  }
```

- [ ] **Step 6 : Wiring module**

Vérifier que `TicketAssetService` est injectable dans `MyTicketsController` : dans `src/orders/orders.module.ts`, importer le module qui exporte `TicketAssetService` (`TicketAssetModule` — `src/ticket-asset/ticket-asset.module.ts` l'exporte déjà). Si l'import manque, l'ajouter à `imports: [...]`.

- [ ] **Step 7 : Succès + suite**

Run: `cd /Users/user/vybe && npx jest src/orders/MyTickets.service.spec.ts src/ticket-asset/ticket-asset.service.spec.ts && npx jest`
Expected: PASS ciblés + suite complète verte.

- [ ] **Step 8 : Commit**

```bash
cd /Users/user/vybe
git add src/ticket-asset/ticket-asset.service.ts src/orders/MyTickets.service.ts src/orders/MyTickets.controller.ts src/orders/orders.module.ts src/orders/MyTickets.service.spec.ts src/ticket-asset/ticket-asset.service.spec.ts
git commit -m "feat(tickets): endpoint download PNG/PDF à la demande (streamé, fallback design, cache/ETag)"
```

---

### Task 4 : Frontend — service + hook token (fetch + cache persistant + préchargement)

**Files:**
- Modify: `src/services/tickets.service.ts` (`getQrToken`, `downloadTicket`)
- Modify: `src/hooks/queries/keys.ts` (`tickets.qrToken(id)`)
- Create: `src/hooks/queries/use-ticket-token.ts` (hook + préchargement)
- Modify: `src/types/api.ts` (`MyTicketDto` : ajouter `ticketDesignUrl`)
- Test: `src/services/tickets.service.test.ts` (si présent) ou nouveau

**Interfaces:**
- Produces: `ticketsService.getQrToken(id)`, `ticketsService.downloadTicket(id, format)` (blob) ; `useTicketToken(id)` (lecture + cache localStorage) ; `prefetchUpcomingTokens(queryClient, ids)`.

- [ ] **Step 1 : Type**

Dans `src/types/api.ts`, `MyTicketDto` : ajouter `ticketDesignUrl: string;` (et laisser `ticketImageUrl`/`pdfUrl` pour l'instant — retirés Tâche 8).

- [ ] **Step 2 : Clé de query**

Dans `src/hooks/queries/keys.ts`, sous `tickets` : `qrToken: (id: string) => ["tickets", "qr-token", id] as const,`.

- [ ] **Step 3 : Service**

Dans `src/services/tickets.service.ts` :
```ts
  /** Token brut d'un billet (propriétaire). Alimente le rendu QR client-side. */
  getQrToken(id: string, signal?: AbortSignal): Promise<{ qrToken: string }> {
    return api.get<{ qrToken: string }>(`/me/tickets/${encodeURIComponent(id)}/qr-token`, { signal });
  },

  /** Fichier billet composé à la demande (png|pdf), en blob (endpoint authentifié). */
  downloadTicket(id: string, format: "png" | "pdf", signal?: AbortSignal): Promise<Blob> {
    return api.getBlob(`/me/tickets/${encodeURIComponent(id)}/download?format=${format}`, { signal });
  },
```
Si `api.getBlob` n'existe pas dans `src/lib/api/client.ts`, l'ajouter : un fetch qui pose l'`Authorization: Bearer <accessToken>` (même source que `api.get`) et renvoie `res.blob()` (throw `ApiError` sur `!res.ok`). L'endpoint étant authentifié, un simple `<a href>` ne suffit pas — d'où le fetch+blob.

- [ ] **Step 4 : Hook + cache + préchargement**

Créer `src/hooks/queries/use-ticket-token.ts` :
```ts
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { ticketsService } from "@/services/tickets.service";
import { queryKeys } from "./keys";

const LS_PREFIX = "vybe:qr-token:";
const readLS = (id: string): string | undefined => {
  try { return localStorage.getItem(LS_PREFIX + id) ?? undefined; } catch { return undefined; }
};
const writeLS = (id: string, token: string) => {
  try { localStorage.setItem(LS_PREFIX + id, token); } catch { /* quota/privé : on ignore */ }
};

/** Token d'un billet : réseau puis cache localStorage (offline). staleTime infini. */
export function useTicketToken(id: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tickets.qrToken(id),
    queryFn: async ({ signal }) => {
      const { qrToken } = await ticketsService.getQrToken(id, signal);
      writeLS(id, qrToken);
      return qrToken;
    },
    initialData: () => readLS(id), // rend le QR hors ligne depuis le cache
    staleTime: Infinity,
    enabled,
  });
}

/** Préchargement proactif des tokens des billets À VENIR, tant qu'il y a du réseau. */
export async function prefetchUpcomingTokens(qc: QueryClient, ids: string[]): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  const LIMIT = 4; // limite de parallélisme
  for (let i = 0; i < ids.length; i += LIMIT) {
    await Promise.allSettled(
      ids.slice(i, i + LIMIT).map((id) =>
        qc.prefetchQuery({
          queryKey: queryKeys.tickets.qrToken(id),
          queryFn: async () => {
            const { qrToken } = await ticketsService.getQrToken(id);
            writeLS(id, qrToken);
            return qrToken;
          },
          staleTime: Infinity,
        }),
      ),
    );
  }
}
```

- [ ] **Step 5 : Vérif + commit**

Run: `cd /Users/user/vybeFrontend && npx tsc --noEmit && npm run test`
Expected: tsc OK, suite verte.
```bash
git add src/services/tickets.service.ts src/lib/api/client.ts src/hooks/queries/keys.ts src/hooks/queries/use-ticket-token.ts src/types/api.ts
git commit -m "feat(tickets): service+hook token QR (cache localStorage + préchargement à venir)"
```

---

### Task 5 : Frontend — rendu billet client-side + download serveur

**Files:**
- Rewrite: `src/components/vybe/MyTicketItem.tsx` (rendu client-side)
- Create: `src/lib/cloudinary.ts` (`cloudinaryTransformed`)
- Rewrite: `src/lib/download.ts` (download depuis blob authentifié)
- Modify: `src/components/vybe/Tickets.tsx` (déclencher `prefetchUpcomingTokens`)
- Test: mise à jour de `src/components/vybe/MyTicketItem.test.tsx`

**Interfaces:**
- Consumes: `useTicketToken` (T4), `ticketsService.downloadTicket`, `MyTicketDto.ticketDesignUrl`.

- [ ] **Step 1 : Helper transform Cloudinary**

Créer `src/lib/cloudinary.ts` :
```ts
/** Insère f_auto,q_auto,w_<width> après /upload/ pour servir une image adaptée. */
export function cloudinaryTransformed(secureUrl: string, width: number): string {
  const marker = "/upload/";
  const i = secureUrl.indexOf(marker);
  if (i === -1) return secureUrl;
  const at = i + marker.length;
  return `${secureUrl.slice(0, at)}f_auto,q_auto,w_${width}/${secureUrl.slice(at)}`;
}
```

- [ ] **Step 2 : Download depuis blob**

Réécrire `src/lib/download.ts` :
```ts
import { ticketsService } from "@/services/tickets.service";

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Télécharge le billet (png|pdf) via l'endpoint serveur authentifié. */
export async function downloadTicket(id: string, format: "png" | "pdf", filename: string): Promise<void> {
  const blob = await ticketsService.downloadTicket(id, format);
  triggerBlobDownload(blob, filename);
}
```

- [ ] **Step 3 : Réécrire `MyTicketItem.tsx`**

Rendu client-side : fond design transformé (avec fallback neutre si l'image échoue), QR `qrcode.react` par-dessus (rendu depuis le token), overlay statut, boutons PNG/PDF branchés sur l'endpoint. Garder le floutage USED/CANCELLED.

```tsx
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Download, FileText, ImageIcon, Loader2, Lock } from "lucide-react";
import { useTicketToken } from "@/hooks/queries/use-ticket-token";
import { downloadTicket } from "@/lib/download";
import { cloudinaryTransformed } from "@/lib/cloudinary";
import type { MyTicketDto, QrStatus } from "@/types/api";

const STATUS: Record<QrStatus, { label: string; className: string }> = {
  UNUSED: { label: "Valide", className: "bg-[hsl(145_60%_92%)] text-[hsl(150_65%_32%)]" },
  USED: { label: "Utilisé", className: "bg-black/5 text-black/50" },
  CANCELLED: { label: "Annulé", className: "bg-[hsl(350_80%_94%)] text-[hsl(350_70%_45%)]" },
};
const OVERLAY_LABEL: Partial<Record<QrStatus, string>> = { USED: "Billet déjà utilisé", CANCELLED: "Billet annulé" };

export function MyTicketItem({ ticket, eventTitle }: { ticket: MyTicketDto; eventTitle: string }) {
  const status = STATUS[ticket.qrStatus];
  const inactive = ticket.qrStatus === "USED" || ticket.qrStatus === "CANCELLED";
  const overlayLabel = OVERLAY_LABEL[ticket.qrStatus];
  const baseName = `billet-${eventTitle}-${ticket.categoryName}`;

  // Token seulement pour un billet valide (inutile de le charger pour un billet inactif).
  const token = useTicketToken(ticket.id, !inactive);
  const [bgFailed, setBgFailed] = useState(false);
  const [busy, setBusy] = useState<null | "png" | "pdf">(null);

  const onDownload = async (format: "png" | "pdf") => {
    setBusy(format);
    try { await downloadTicket(ticket.id, format, `${baseName}.${format}`); }
    finally { setBusy(null); }
  };

  return (
    <div className="rounded-3xl bg-card border border-black/5 shadow-[0_10px_40px_-14px_rgba(0,0,0,0.25)] overflow-hidden">
      {/* Couche fond design (Cloudinary transformé) + couche QR par-dessus. */}
      <div className="relative aspect-[3/4] bg-[#0b0b12]">
        {!bgFailed && (
          <img
            src={cloudinaryTransformed(ticket.ticketDesignUrl, 640)}
            alt={`Billet ${eventTitle} — ${ticket.categoryName}`}
            className="absolute inset-0 w-full h-full object-cover"
            onError={() => setBgFailed(true)}
          />
        )}
        {/* QR : rendu depuis le token (offline via cache). Flou si inactif. */}
        <div className={`absolute left-1/2 -translate-x-1/2 bottom-6 bg-white rounded-2xl p-3 ${inactive ? "blur-md" : ""}`}>
          {inactive ? (
            <div className="w-[160px] h-[160px] grid place-items-center text-black/40"><Lock className="w-8 h-8" /></div>
          ) : token.data ? (
            <QRCodeSVG value={token.data} size={160} level="M" />
          ) : token.isError ? (
            <div className="w-[160px] h-[160px] grid place-items-center text-center text-xs text-black/50 px-2">
              QR indisponible hors ligne
            </div>
          ) : (
            <div className="w-[160px] h-[160px] grid place-items-center"><Loader2 className="w-6 h-6 animate-spin text-black/40" /></div>
          )}
        </div>
        {inactive && (
          <div className="absolute inset-x-0 bottom-2 flex justify-center">
            <span className="px-3 py-1.5 rounded-full bg-black/75 text-white text-[11px] font-bold uppercase tracking-wide">{overlayLabel}</span>
          </div>
        )}
      </div>

      <div className="p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="font-bold text-foreground truncate">{ticket.categoryName}</p>
          <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${status.className}`}>{status.label}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <button type="button" disabled={inactive || busy !== null} onClick={() => onDownload("png")}
            className="flex items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold bg-gradient-vybe text-white disabled:opacity-40 disabled:cursor-not-allowed">
            {busy === "png" ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImageIcon className="w-4 h-4" />} PNG
          </button>
          <button type="button" disabled={inactive || busy !== null} onClick={() => onDownload("pdf")}
            className="flex items-center justify-center gap-2 rounded-full py-3 text-sm font-semibold bg-card text-foreground border border-black/10 disabled:opacity-40 disabled:cursor-not-allowed">
            {busy === "pdf" ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />} PDF
          </button>
        </div>
        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          {inactive ? (<><Lock className="w-3.5 h-3.5" />{overlayLabel} — téléchargement indisponible</>)
                    : (<><Download className="w-3.5 h-3.5" />Télécharge ton billet en PNG ou en PDF</>)}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4 : Préchargement dans `Tickets.tsx`**

Dans `src/components/vybe/Tickets.tsx`, après le chargement réussi des billets, déclencher le préchargement des tokens des billets **à venir** :
```tsx
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { prefetchUpcomingTokens } from "@/hooks/queries/use-ticket-token";
// ...
const qc = useQueryClient();
useEffect(() => {
  if (!data) return;
  const upcomingIds = data.upcoming.flatMap((e) => e.tickets)
    .filter((t) => t.qrStatus === "UNUSED").map((t) => t.id);
  void prefetchUpcomingTokens(qc, upcomingIds);
}, [data, qc]);
```
(`data` = résultat de `useMyTickets()` déjà présent dans le composant.)

- [ ] **Step 5 : Mettre à jour `MyTicketItem.test.tsx`**

Adapter le test : mocker `@/hooks/queries/use-ticket-token` (`useTicketToken` → `{ data: "tok", isError: false }`) et `@/lib/download`. Fournir `ticketDesignUrl` dans le fake ticket. Vérifier : le QR (svg) est rendu pour un billet UNUSED ; le clic PNG appelle `downloadTicket(id, "png", ...)` ; un billet USED est flouté et ses boutons désactivés.

- [ ] **Step 6 : Gate**

Run: `cd /Users/user/vybeFrontend && npx tsc --noEmit && npm run lint && npm run test && npm run build`
Expected: tout vert.

- [ ] **Step 7 : Commit**

```bash
cd /Users/user/vybeFrontend
git add src/components/vybe/MyTicketItem.tsx src/lib/cloudinary.ts src/lib/download.ts src/components/vybe/Tickets.tsx src/components/vybe/MyTicketItem.test.tsx
git commit -m "feat(tickets): rendu billet client-side (QR qrcode.react + design transformé) + download serveur"
```

---

### Task 6 : Backend — retrait de la génération eager

**Files:**
- Modify: `src/orders/Order.service.ts` (retirer l'appel post-commit + `TicketAssetService` + select)
- Modify: `src/ticket-asset/ticket-asset.service.ts` (retirer generate/regenerate + Cloudinary)
- Modify: `src/orders/MyTickets.service.ts` (retirer le déclencheur regenerate)
- Modify: modules concernés si une dépendance devient inutilisée
- Test: `src/orders/Order.service.spec.ts`, `src/ticket-asset/ticket-asset.service.spec.ts`, `src/orders/MyTickets.service.spec.ts`

- [ ] **Step 1 : `Order.service.ts`**

Retirer le bloc post-commit (`for (const orderId of orderIds) { ... generateAssetsForOrder ... }`, ~L85-92). Réduire le select de retour (`:97`) à `select: { qrToken: true }`. Retirer l'import et le paramètre constructeur `TicketAssetService` (plus utilisé). Adapter `Order.service.spec.ts` : retirer le mock `ticketAssets` et les assertions de génération ; les `findMany` mockés ne renvoient plus que `{ qrToken }`.
> Note (hors périmètre) : `createOrder` renvoie toujours `qrToken` dans sa réponse — incohérent avec « token seulement via l'endpoint gardé ». À resserrer dans une passe ultérieure ; ne pas changer le contrat ici.

- [ ] **Step 2 : `ticket-asset.service.ts`**

Supprimer `generateAssetsForOrder`, `generateForTickets`, `regenerateMissingForUser`, le champ `inFlight`, le type `TicketWithEvent`, l'injection `CloudinaryService` (constructeur) et les imports devenus inutiles (`CloudinaryService`, `CloudinaryFolder`). **Conserver** : imports `sharp`/`QRCode`/`PDFDocument`/`Prisma`(si encore utilisé, sinon retirer), `TicketFields`, `RenderInput`, `escapeXml`, `dateLabel`, `timeLabel`, `fetchDesign`, `neutralBackground`, `fetchDesignOrFallback`, `renderTicketPng`, `renderTicketPdf`, `buildTicketImage`, `buildTicketPdf`. Adapter `ticket-asset.service.spec.ts` : retirer les tests de génération/regenerate/upload ; garder/ajouter ceux de rendu (T3).

- [ ] **Step 3 : `MyTickets.service.ts`**

Retirer le bloc `hasMissing` / `regenerateMissingForUser` (~L24-33) et l'injection `TicketAssetService` **du service** (⚠ `MyTicketsController` en a toujours besoin pour le download — ne pas retirer côté controller). `getMyTickets` renvoie simplement `{ upcoming, past }`. Adapter `MyTickets.service.spec.ts` : retirer le mock `ticketAssets`/assertions regenerate.

- [ ] **Step 4 : Modules**

Si `TicketAssetService` n'est plus injecté que dans le controller, s'assurer que le module d'`orders` importe toujours `TicketAssetModule` (fait en T3). Retirer `CloudinaryModule` de `ticket-asset.module.ts` **uniquement si** plus rien dans ce module n'utilise Cloudinary (⚠ `tickets.cleanup.ts` l'utilise encore jusqu'à la Tâche 7 — ne pas retirer avant).

- [ ] **Step 5 : Suite complète**

Run: `cd /Users/user/vybe && npx jest`
Expected: verte (specs adaptés).

- [ ] **Step 6 : Commit**

```bash
cd /Users/user/vybe
git add src/orders/Order.service.ts src/ticket-asset/ticket-asset.service.ts src/orders/MyTickets.service.ts src/orders/Order.service.spec.ts src/ticket-asset/ticket-asset.service.spec.ts src/orders/MyTickets.service.spec.ts
git commit -m "refactor(tickets): retire la génération/upload d'assets par billet (achat + rattrapage)"
```

---

### Task 7 : Backend — `tickets.cleanup` : purge de lignes seule

**Files:**
- Modify: `src/ticket-asset/tickets.cleanup.ts`
- Modify: `src/ticket-asset/ticket-asset.module.ts` (retirer `CloudinaryModule` si plus utilisé)
- Test: `src/ticket-asset/tickets.cleanup.spec.ts`

- [ ] **Step 1 : Réécrire le cron**

`purgeExpired` : charger les billets expirés (juste `id`), supprimer les **lignes** (`ticket.delete` ou `deleteMany`), sans aucun appel Cloudinary. Retirer l'injection `CloudinaryService`, l'import `publicIdFromUrl`, le select `ticketImageUrl`/`pdfUrl`. Version cible :
```ts
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpired() {
    const now = new Date();
    const { count } = await this.prisma.ticket.deleteMany({ where: { expiresAt: { lt: now } } });
    if (count) this.logger.log(`Purge de ${count} billet(s) expiré(s).`);
  }
```

- [ ] **Step 2 : Adapter le spec**

`tickets.cleanup.spec.ts` : retirer le mock Cloudinary et les assertions de suppression d'assets ; asserter `deleteMany({ where: { expiresAt: { lt: <now> } } })` et le log du compte.

- [ ] **Step 3 : Module**

Retirer `CloudinaryModule` de `ticket-asset.module.ts` s'il n'est plus utilisé (ni par le service ni par le cleanup).

- [ ] **Step 4 : Suite + commit**

Run: `cd /Users/user/vybe && npx jest`
```bash
git add src/ticket-asset/tickets.cleanup.ts src/ticket-asset/tickets.cleanup.spec.ts src/ticket-asset/ticket-asset.module.ts
git commit -m "refactor(tickets): purge cron = suppression de lignes expirées (plus d'assets Cloudinary par billet)"
```

---

### Task 8 : Backend — retirer les colonnes `ticketImageUrl`/`pdfUrl`

**Files:**
- Modify: `src/orders/dto/MyTickets.dto.ts` (retirer les 2 champs)
- Modify: `src/orders/MyTickets.service.ts` (retirer du select + map)
- Modify: `src/types/api.ts` (frontend) (retirer les 2 champs)
- Modify: `prisma/schema.prisma` (drop colonnes) + migration
- Test: specs concernés

**Pré-requis (R3) :** re-lancer `grep -rniE 'ticketImageUrl|pdfUrl' src prisma` (backend) et `src` (frontend) et confirmer que seuls restent : DTO, MyTickets.service map, schema, et les specs — **aucun autre lecteur**. Sinon, corriger avant de dropper.

- [ ] **Step 1 : DTO + service (backend)**

Retirer `ticketImageUrl`/`pdfUrl` de `MyTicketDto`, du `select` de `fetchRows` et du `push` de `groupByEvent`. Adapter `MyTickets.service.spec.ts`.

- [ ] **Step 2 : Type frontend**

Dans `src/types/api.ts`, retirer `ticketImageUrl`/`pdfUrl` de `MyTicketDto` (le rendu client-side ne les lit plus). Vérifier qu'aucun composant ne les référence (grep frontend).

- [ ] **Step 3 : Migration Prisma**

Retirer les colonnes du modèle `Ticket` (`prisma/schema.prisma`), puis :
```bash
cd /Users/user/vybe && npx prisma migrate dev --name drop_ticket_asset_urls
```
⚠ Base Neon partagée : voir les précautions habituelles de migration du repo (une base par branche / réconciliation du ledger).

- [ ] **Step 4 : Suites (2 repos)**

Run: `cd /Users/user/vybe && npx jest` et `cd /Users/user/vybeFrontend && npx tsc --noEmit && npm run test && npm run build`
Expected: tout vert.

- [ ] **Step 5 : Commit (2 repos)**

```bash
cd /Users/user/vybe
git add prisma/ src/orders/dto/MyTickets.dto.ts src/orders/MyTickets.service.ts src/orders/MyTickets.service.spec.ts
git commit -m "feat(tickets): drop colonnes ticketImageUrl/pdfUrl (assets à la volée)"
cd /Users/user/vybeFrontend
git add src/types/api.ts
git commit -m "chore(tickets): retire ticketImageUrl/pdfUrl du type MyTicketDto"
```

---

### Task 9 : Backend — purge one-shot du dossier Cloudinary `TICKETS`

**Files:**
- Create: `scripts/purge-ticket-assets.ts` (script admin ponctuel)

- [ ] **Step 1 : Script**

Créer un script Node qui, via l'Admin API Cloudinary, supprime les ressources sous le préfixe du dossier `TICKETS` (images puis raw/PDF). S'appuyer sur la config Cloudinary existante (`CLOUDINARY_*`). Exemple :
```ts
import { v2 as cloudinary } from 'cloudinary';
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});
const PREFIX = 'tickets/'; // = CloudinaryFolder.TICKETS
async function main() {
  for (const type of ['image', 'raw'] as const) {
    let next: string | undefined;
    do {
      const r: any = await cloudinary.api.delete_resources_by_prefix(PREFIX, { resource_type: type, next_cursor: next });
      next = r.next_cursor;
      console.log(`[${type}] supprimés:`, Object.keys(r.deleted ?? {}).length);
    } while (next);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
```
Vérifier le préfixe réel dans `src/cloudinary/cloudinary.folder.ts` (`CloudinaryFolder.TICKETS`) et l'ajuster.

- [ ] **Step 2 : Exécution (manuelle, une fois)**

Exécuter en staging d'abord (`npx ts-node scripts/purge-ticket-assets.ts`), vérifier le compte supprimé, puis en prod. **Ne pas** l'automatiser (one-shot).

- [ ] **Step 3 : Commit**

```bash
cd /Users/user/vybe
git add scripts/purge-ticket-assets.ts
git commit -m "chore(tickets): script one-shot de purge du dossier Cloudinary TICKETS"
```

---

## Self-review

- **Couverture spec** : décisions 1-5 (T1 qr-token, T3 download, T5 rendu client-side, Cloudinary=design seul via T6-7, retrait eager T6) ; P1 (T8 drop + T9 purge) ; P2 offline (T4 cache+préchargement, T5 fallback) ; P3 cache (T3 ETag/Cache-Control) ; P4 fallback design (T3 `fetchDesignOrFallback`, T5 `onError`) ; R1 (T4 `prefetchUpcomingTokens`) ; R2 (T1/T3 `findFirst` joint + 404) ; R3 (T8 pré-requis grep).
- **Ordre sans casse** : endpoints + `ticketDesignUrl` (T1-3) et bascule front (T4-5) précèdent tout retrait ; les colonnes ne sont droppées (T8) qu'après que le front a cessé de les lire.
- **Type/nom cohérents** : `RenderInput`, `getQrToken`, `getTicketForRender`, `useTicketToken`, `prefetchUpcomingTokens`, `cloudinaryTransformed`, `downloadTicket` employés identiquement d'une tâche à l'autre.
- **Hypothèses à confirmer à l'implémentation** : présence/forme de `api.getBlob` (T4 Step 3) ; nom exact du module d'orders (`orders.module.ts`) et de l'export `TicketAssetModule` ; que `MyTickets.service.spec.ts` expose `findFirst` sur le mock prisma (l'ajouter sinon).
