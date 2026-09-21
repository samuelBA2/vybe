import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { QRStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MyEventTicketsDto, MyTicketsResponseDto } from './dto/MyTickets.dto';
import { MY_TICKETS_MAX_PER_SCOPE } from 'src/common/constants';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MyTicketsService {
    private readonly logger = new Logger(MyTicketsService.name);
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
    // Signal explicite si un scope a atteint le plafond de sécurité : jamais de
    // troncature silencieuse. Un utilisateur réel ne déclenche jamais ceci.
    const truncated = upcoming.truncated || past.truncated;
    if (truncated) {
        this.logger.warn(
            `Plafond /me/tickets atteint (userId=${userId}, upcoming=${upcoming.truncated}, past=${past.truncated}) — passer à une pagination par événement.`,
        );
    }
    return { upcoming: upcoming.events, past: past.events, truncated };
    }

    private async getScope(
        userId: string,
        now: Date,
        scope: 'upcoming' | 'past',
        ): Promise<{ events: MyEventTicketsDto[]; truncated: boolean }> {
    const rows = await this.fetchRows(userId, now, scope);
    // rows a été lu en take: MAX+1 → au-delà de MAX, le plafond est dépassé.
    const truncated = rows.length > MY_TICKETS_MAX_PER_SCOPE;
    const bounded = truncated ? rows.slice(0, MY_TICKETS_MAX_PER_SCOPE) : rows;
    return { events: this.groupByEvent(bounded), truncated };
    }

    private fetchRows(userId: string, now: Date, scope: 'upcoming' | 'past') {
    // Un billet annulé reste visible 24h, puis disparaît de la liste
    const cutoff = new Date(now.getTime() - DAY_MS);
    const isUpcoming = scope === 'upcoming';

    return this.prisma.ticket.findMany({
    where: {
        // Seuls les billets d'une commande PAYÉE apparaissent ici. Exclut les GIFT
        // (onglet dédié getMyGifts) ET tout billet dont la commande ne serait pas
        // (ou plus) PAID — durci depuis le vrai flux de paiement (PENDING/EXPIRED/
        // REVIEW n'ont pas de billet, mais on verrouille l'invariant côté requête).
        order: { userId, paymentStatus: 'PAID' },
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
    // Garde-fou (pas une pagination) : +1 pour détecter si le plafond est atteint.
    take: MY_TICKETS_MAX_PER_SCOPE + 1,
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
                category: true,
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
            category: ev.category,
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

    // Onglet « Tickets offerts » : billets GIFT du user, VISIBLES uniquement tant
    // qu'ils sont UNUSED ET pas encore téléchargés (giftDownloadedAt null). Une fois
    // téléchargés ou scannés, ils disparaissent définitivement (pas de flou, disparition totale).
    async getMyGifts(userId: string): Promise<{ events: MyEventTicketsDto[] }> {
        const rows = await this.prisma.ticket.findMany({
            where: {
                order: { userId, paymentStatus: 'GIFT' },
                qrStatus: QRStatus.UNUSED,
                giftDownloadedAt: null,
            },
            orderBy: [
                { ticketCategory: { event: { startDate: 'asc' } } },
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
                                id: true, reference: true, title: true, category: true,
                                startDate: true, endDate: true, location: true,
                                mediaFiles: { where: { isPoster: true }, take: 1, select: { url: true } },
                            },
                        },
                    },
                },
            },
        });
        return { events: this.groupByEvent(rows) };
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
                order: { select: { paymentStatus: true } },
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

    // Marque un billet OFFERT comme téléchargé (disparition définitive de l'onglet).
    // updateMany gardé : ne touche que le billet GIFT du propriétaire encore non
    // téléchargé → idempotent, no-op sur un billet normal ou déjà marqué.
    async markGiftDownloaded(userId: string, ticketId: string): Promise<void> {
        await this.prisma.ticket.updateMany({
            where: { id: ticketId, order: { userId, paymentStatus: 'GIFT' }, giftDownloadedAt: null },
            data: { giftDownloadedAt: new Date() },
        });
    }
}