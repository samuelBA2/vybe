import { MyTicketsService } from './MyTickets.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('MyTicketsService', () => {
  let service: MyTicketsService;
  let prisma: { ticket: { findMany: jest.Mock } };

  beforeEach(() => {
    prisma = { ticket: { findMany: jest.fn() } };
    service = new MyTicketsService(prisma as unknown as PrismaService);
  });

  const HOUR = 3_600_000;
  const now = Date.now();

  // Fabrique une ligne Ticket telle que renvoyée par findMany (relations incluses).
  const row = (over: any = {}) => ({
    id: over.id ?? 't1',
    qrStatus: over.qrStatus ?? 'UNUSED',
    ticketImageUrl: 'ticketImageUrl' in over ? over.ticketImageUrl : 'png-url',
    pdfUrl: 'pdfUrl' in over ? over.pdfUrl : 'pdf-url',
    expiresAt: over.expiresAt ?? new Date(now + 48 * HOUR),
    cancelledAt: over.cancelledAt ?? null,
    ticketCategory: {
      name: over.categoryName ?? 'VIP',
      event: {
        id: over.eventId ?? 'ev-future',
        reference: over.reference ?? 'VYBE-AAA',
        title: over.title ?? 'Soirée',
        startDate: over.startDate ?? new Date(now + 24 * HOUR),
        endDate: over.endDate ?? new Date(now + 30 * HOUR),
        location: over.location ?? 'Paris',
        mediaFiles: over.mediaFiles ?? [{ url: 'poster-url' }],
      },
    },
  });

  it('utilisateur sans billet → { upcoming: [], past: [] }', async () => {
    prisma.ticket.findMany.mockResolvedValue([]);
    const res = await service.getMyTickets('user-1');
    expect(res).toEqual({ upcoming: [], past: [] });
    // Ne charge que les billets de cet utilisateur.
    expect(prisma.ticket.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { order: { userId: 'user-1' } } }),
    );
  });

  it('plusieurs billets du même événement → une entrée, tous les billets dedans', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 't1', eventId: 'ev-1' }),
      row({ id: 't2', eventId: 'ev-1' }),
      row({ id: 't3', eventId: 'ev-1' }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming).toHaveLength(1);
    expect(res.upcoming[0].tickets.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('mappe les champs billet (pas de qrToken) et posterUrl', async () => {
    prisma.ticket.findMany.mockResolvedValue([row({ id: 't1' })]);
    const res = await service.getMyTickets('user-1');
    const evt = res.upcoming[0];
    expect(evt.event.posterUrl).toBe('poster-url');
    expect(evt.tickets[0]).toEqual({
      id: 't1',
      categoryName: 'VIP',
      qrStatus: 'UNUSED',
      ticketImageUrl: 'png-url',
      pdfUrl: 'pdf-url',
      expiresAt: expect.any(Date),
      cancelledAt: null,
    });
    expect(evt.tickets[0]).not.toHaveProperty('qrToken');
  });

  it('split upcoming/past selon endDate vs now', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 'fut', eventId: 'ev-fut', endDate: new Date(now + 5 * HOUR) }),
      row({ id: 'pas', eventId: 'ev-pas', endDate: new Date(now - 5 * HOUR), startDate: new Date(now - 10 * HOUR) }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming.map((e) => e.event.id)).toEqual(['ev-fut']);
    expect(res.past.map((e) => e.event.id)).toEqual(['ev-pas']);
  });

  it('trie upcoming croissant (le plus proche d\'abord) et past décroissant', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 'u-late', eventId: 'u-late', startDate: new Date(now + 20 * HOUR), endDate: new Date(now + 21 * HOUR) }),
      row({ id: 'u-soon', eventId: 'u-soon', startDate: new Date(now + 2 * HOUR), endDate: new Date(now + 3 * HOUR) }),
      row({ id: 'p-old', eventId: 'p-old', startDate: new Date(now - 40 * HOUR), endDate: new Date(now - 39 * HOUR) }),
      row({ id: 'p-recent', eventId: 'p-recent', startDate: new Date(now - 5 * HOUR), endDate: new Date(now - 4 * HOUR) }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming.map((e) => e.event.id)).toEqual(['u-soon', 'u-late']);
    expect(res.past.map((e) => e.event.id)).toEqual(['p-recent', 'p-old']);
  });

  it('annulé il y a 23h → visible ; 25h → masqué ; CANCELLED sans date → masqué', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 'keep-unused', eventId: 'ev-1', qrStatus: 'UNUSED' }),
      row({ id: 'keep-23h', eventId: 'ev-1', qrStatus: 'CANCELLED', cancelledAt: new Date(now - 23 * HOUR) }),
      row({ id: 'drop-25h', eventId: 'ev-1', qrStatus: 'CANCELLED', cancelledAt: new Date(now - 25 * HOUR) }),
      row({ id: 'drop-null', eventId: 'ev-1', qrStatus: 'CANCELLED', cancelledAt: null }),
    ]);
    const res = await service.getMyTickets('user-1');
    const ids = res.upcoming[0].tickets.map((t) => t.id);
    expect(ids).toContain('keep-unused');
    expect(ids).toContain('keep-23h');
    expect(ids).not.toContain('drop-25h');
    expect(ids).not.toContain('drop-null');
  });

  it('poster absent → posterUrl null ; visuels non générés → urls null', async () => {
    prisma.ticket.findMany.mockResolvedValue([
      row({ id: 't1', mediaFiles: [], ticketImageUrl: null, pdfUrl: null }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming[0].event.posterUrl).toBeNull();
    expect(res.upcoming[0].tickets[0].ticketImageUrl).toBeNull();
    expect(res.upcoming[0].tickets[0].pdfUrl).toBeNull();
  });
});
