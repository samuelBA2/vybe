import { Injectable, NotFoundException } from '@nestjs/common';
import { QRStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MyEventTicketsDto, MyTicketsResponseDto } from './dto/MyTickets.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MyTicketsService {
    constructor(private readonly prisma: PrismaService) {}

    // Plus de rattrapage ici : il n'y a plus de visuel stocké à régénérer,
    // le PNG/PDF est rendu à la demande (voir MyTicketsController.download →
    // TicketAssetService.renderTicketPng/Pdf).
    async getMyTickets(userId: string): Promise<MyTicketsResponseDto> {
    const now = new Date();
    const [upcoming, past] = await Promise.all([
        this.getScope(userId, now, 'upcoming'),
        this.getScope(userId, now, 'past'),
    ]);
    return { upcoming, past };
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
        expiresAt: true,
        cancelledAt: true,
        ticketCategory: {
        select: {
            name: true,
            ticketDesignUrl: true,
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
        ticketDesignUrl: t.ticketCategory.ticketDesignUrl,
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

    // Données jointes pour composer le billet à la demande (route /download).
    // Même garde d'ownership qu'ailleurs (Ticket→Order.userId en une requête) :
    // non-propriétaire → 404, jamais 403 (pas de fuite d'existence du billet).
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
}