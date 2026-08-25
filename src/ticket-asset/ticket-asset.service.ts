import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import * as QRCode from 'qrcode';
import PDFDocument from 'pdfkit';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';
import { CloudinaryFolder } from 'src/cloudinary/cloudinary.folder';

export type TicketFields = {
    qrToken: string;
    eventCategory: string; // Event.category, ex: 'FESTIVAL'
    eventTitle: string;    // Event.title, ex: 'Neon Nights'
    dateLabel: string;     // ex: 'Ven. 27 juin'
    timeLabel: string;     // ex: '22:00'
    placeLabel: string;    // ex: 'Standard'
};

// Billet avec sa catégorie et son événement, tel que chargé pour la génération.
type TicketWithEvent = Prisma.TicketGetPayload<{
    include: { ticketCategory: { include: { event: true } } };
}>;

// Échapp une valeur (saisie utilisateur) avant insertion dans le SVG pour éviter de casser le rendu.
function escapeXml(s: string): string {
    return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string),);}

    @Injectable()
    export class TicketAssetService {
        private readonly logger = new Logger(TicketAssetService.name);

        // userId dont un rattrapage est déjà en cours (anti double-régénération).
        private readonly inFlight = new Set<string>();

        constructor(
            private readonly prisma: PrismaService,
            private readonly cloudinary: CloudinaryService,
        ) {}

        private dateLabel(d: Date): string {
            const s = d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
            return s.charAt(0).toUpperCase() + s.slice(1); // capitalize  // "ven. 27 juin" -> "Ven. 27 juin"
        }

        private timeLabel(d: Date): string {
            return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        }

        private async fetchDesign(url: string): Promise<Buffer> {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Impossible de récupérer le design depuis ${res.status} : ${url}`);
            return Buffer.from(await res.arrayBuffer());
        }

         // Post-commit best-effort : génère PNG+PDF de chaque billet de la commande.
         // Ne throw jamais : un échec laisse le billet avec des URLs null (rattrapé en brique C).
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
            await Promise.allSettled(tickets.map(async (t) => {
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
                    })
                    const imageRes = await this.cloudinary.uploadBuffer(png, CloudinaryFolder.TICKETS);
                    const pdf = await this.buildTicketPdf(png);
                    const pdfRes = await this.cloudinary.uploadRawBuffer(pdf, CloudinaryFolder.TICKETS, `ticket-${t.id}`);
                    await this.prisma.ticket.update({
                        where: { id: t.id },
                        data: { ticketImageUrl: imageRes.secure_url, pdfUrl: pdfRes.secure_url },
                    });
                } catch (e){
                    this.logger.error(`Echec génération des visuels du billet ${t.id} : ${(e instanceof Error ? e.stack : String(e))}`,)
                }
            }))
        }

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

        // Rend la carte du billet (PNG, 750x1040) à partir du design (PNG) et des champs du billet.
        async buildTicketImage(designBuffer: Buffer, fields: TicketFields): Promise<Buffer> {
            const W = 750;
            const HEADER_H = 300;
            const H = 1040;

            // En-tête : image de design recadrée cover.
            const header = await sharp(designBuffer)
                .resize({ width: W, height: HEADER_H, fit: 'cover' })
                .png()
                .toBuffer();
            const headerB64 = `data:image/png;base64,${header.toString('base64')}`;

            // QR à partir du qrToken brut.
            const qrPng = await QRCode.toBuffer(fields.qrToken, { width: 360, margin: 1, errorCorrectionLevel: 'M' });
            const qrB64 = `data:image/png;base64,${qrPng.toString('base64')}`;

            const cat = escapeXml(fields.eventCategory);
            const title = escapeXml(fields.eventTitle);
            const date = escapeXml(fields.dateLabel);
            const time = escapeXml(fields.timeLabel);
            const place = escapeXml(fields.placeLabel);

            // Carte finale : SVG avec header + QR + ruban de catégorie + texte.
            const svg = 
            `
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
    
    // Resterisation 

    return sharp(Buffer.from(svg))
        .png()
        .toBuffer();

        }

        async buildTicketPdf(ticketPng: Buffer): Promise<Buffer> {
            const meta = await sharp(ticketPng).metadata();
            const w = meta.width ?? 0; // valeur finale non connue avant le rendu 
            const h = meta.height ?? 0;
            return new Promise<Buffer>((resolve, reject) => {
                const doc = new PDFDocument({ size: [w, h], margin: 0 });
                const chunks: Buffer[] = []; 

                doc.on('data', (chunk) => chunks.push(chunk));
                doc.on('end', () => resolve(Buffer.concat(chunks)));
                doc.on('error', (err) => reject(err));
                doc.image(ticketPng, 0, 0, { width: w, height: h });
                doc.end();
            })
        }

    }
