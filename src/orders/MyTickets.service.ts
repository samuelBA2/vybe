import { Injectable } from "@nestjs/common";
import { PrismaService } from "src/prisma/prisma.service";
import { MyTicketsResponseDto, MyEventTicketsDto } from './dto/MyTickets.dto';

const DAY_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class MyTicketsService {
    constructor(private readonly prisma: PrismaService) {}

    async getMyTickets(userId: string): Promise<MyTicketsResponseDto> {
        const now = new Date();
        const cutoff = new Date(now.getTime() - DAY_MS); // 24h annule la visibilié des billets scannés
        const rows = await this.prisma.ticket.findMany({
            where: { order: { userId }},
            include: {
                ticketCategory:{
                    include: {
                        event: {
                            include: {
                                mediaFiles: { where: { isPoster: true }, take: 1 } 
                            }
                        }
                    }
                }
            }
        })
        const kept = rows.filter((t)=> t.qrStatus !== 'CANCELLED' || (t.cancelledAt != null && t.cancelledAt >= cutoff));
        const byEvent = new Map<string, MyEventTicketsDto>();
        for (const t of kept) {
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
                        posterUrl: ev.mediaFiles[0]?.url ?? null
                    },
                    tickets: []
                }
                byEvent.set(ev.id, entry);
            }
            entry.tickets.push({
                id: t.id,
                categoryName: t.ticketCategory.name,
                qrStatus: t.qrStatus,
                ticketImageUrl: t.ticketImageUrl,
                pdfUrl: t.pdfUrl,
                expiresAt: t.expiresAt,
                cancelledAt: t.cancelledAt
            });
        }
        const groups = [...byEvent.values()];
        const upcoming = groups.filter((g) => g.event.endDate >= now).sort((a, b)=> a.event.startDate.getTime() - b.event.startDate.getTime());
        const past = groups.filter((g) => g.event.endDate < now).sort((a, b)=> b.event.startDate.getTime() - a.event.startDate.getTime());
        return { upcoming, past };
    }
}
