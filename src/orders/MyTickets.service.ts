import { Injectable, NotFoundException } from '@nestjs/common';
import { QRStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { TicketAssetService } from 'src/ticket-asset/ticket-asset.service';
import { MyEventTicketsDto, MyTicketsResponseDto } from './dto/MyTickets.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MyTicketsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly ticketAssets: TicketAssetService,
    ) {}

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

    private async getScope(
        userId: string,
        now: Date,
        scope: 'upcoming' | 'past',
        ): Promise<MyEventTicketsDto[]> {
    const rows = await this.fetchRows(userId, now, scope);
    return this.groupByEvent(rows);
    }

    private fetchRows(userId: string, now: Date, scope: 'upcoming' | 'past') {
    // Un billet annulé reste visible 24h, puis disparaît de la liste
    const cutoff = new Date(now.getTime() - DAY_MS);
    const isUpcoming = scope === 'upcoming';

    return this.prisma.ticket.findMany({
    where: {
        order: { userId },
        OR: [
        { qrStatus: { not: QRStatus.CANCELLED } },
        { cancelledAt: { gte: cutoff } },
        ],
        ticketCategory: {
        event: { endDate: isUpcoming ? { gte: now } : { lt: now } },
        },
    },
    orderBy: [
        { ticketCategory: { event: { startDate: isUpcoming ? 'asc' : 'desc' } } },
        { createdAt: 'asc' },
    ],
    select: {
        id: true,
        qrStatus: true,
        ticketImageUrl: true,
        pdfUrl: true,
        expiresAt: true,
        cancelledAt: true,
        ticketCategory: {
        select: {
            name: true,
            event: {
                select: {
                id: true,
                reference: true,
                title: true,
                startDate: true,
                endDate: true,
                location: true,
                mediaFiles: {
                where: { isPoster: true },
                take: 1,
                select: { url: true },
                },
                },
            },
            },
        },
        },
    });
    }

    private groupByEvent(
    rows: Awaited<ReturnType<MyTicketsService['fetchRows']>>,
    ): MyEventTicketsDto[] {
    const byEvent = new Map<string, MyEventTicketsDto>();

    for (const t of rows) {
    const ev = t.ticketCategory.event;
    let entry = byEvent.get(ev.id);

    if (!entry) {
        entry = {
            event: {
            id: ev.id,
            reference: ev.reference,
            title: ev.title,
            startDate: ev.startDate,
            endDate: ev.endDate,
            location: ev.location,
            posterUrl: ev.mediaFiles[0]?.url ?? null,
        },
        tickets: [],
        };
        byEvent.set(ev.id, entry);
    }

        entry.tickets.push({
        id: t.id,
        categoryName: t.ticketCategory.name,
        qrStatus: t.qrStatus,
        ticketImageUrl: t.ticketImageUrl,
        pdfUrl: t.pdfUrl,
        expiresAt: t.expiresAt,
        cancelledAt: t.cancelledAt,
        });
    }

    // L'ordre d'insertion de la Map reflète déjà l'orderBy SQL
    return [...byEvent.values()];
    }

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
}