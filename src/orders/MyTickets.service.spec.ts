import { NotFoundException } from '@nestjs/common';
import { MyTicketsService } from './MyTickets.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { MY_TICKETS_MAX_PER_SCOPE } from 'src/common/constants';

describe('MyTicketsService', () => {
  let service: MyTicketsService;
  let prisma: { ticket: { findMany: jest.Mock; findFirst: jest.Mock } };

  beforeEach(() => {
    prisma = {
      ticket: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
    };
    service = new MyTicketsService(prisma as unknown as PrismaService);
  });

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = Date.now();

  // Ligne Ticket telle que renvoyée par findMany (déjà filtrée/triée par SQL).
  const row = (over: any = {}) => ({
    id: over.id ?? 't1',
    qrStatus: over.qrStatus ?? 'UNUSED',
    expiresAt: over.expiresAt ?? new Date(now + 48 * HOUR),
    cancelledAt: over.cancelledAt ?? null,
    ticketCategory: {
      name: over.categoryName ?? 'VIP',
      ticketDesignUrl: over.ticketDesignUrl ?? 'design-url',
      event: {
        id: over.eventId ?? 'ev-1',
        reference: over.reference ?? 'VYBE-AAA',
        title: over.title ?? 'Soirée',
        startDate: over.startDate ?? new Date(now + 24 * HOUR),
        endDate: over.endDate ?? new Date(now + 30 * HOUR),
        location: over.location ?? 'Paris',
        mediaFiles: over.mediaFiles ?? [{ url: 'poster-url' }],
      },
    },
  });

  // Le service appelle findMany deux fois (upcoming + past). On distingue les
  // deux appels par la forme du filtre endDate : gte = upcoming, lt = past.
  const isUpcomingArgs = (args: any) => !!args.where.ticketCategory.event.endDate.gte;
  const scopedRows = (upcomingRows: any[], pastRows: any[] = []) => {
    prisma.ticket.findMany.mockImplementation((args: any) =>
      Promise.resolve(isUpcomingArgs(args) ? upcomingRows : pastRows),
    );
  };

  // --- Logique JS (groupByEvent) ---

  it('utilisateur sans billet → { upcoming: [], past: [] }', async () => {
    const res = await service.getMyTickets('user-1');
    expect(res).toEqual({ upcoming: [], past: [], truncated: false });
  });

  it('plafond atteint → truncated:true, billets bornés (pas de troncature silencieuse)', async () => {
    // Un scope renvoie MAX+1 lignes (lu en take: MAX+1) → dépassement.
    const many = Array.from({ length: MY_TICKETS_MAX_PER_SCOPE + 1 }, (_, i) =>
      row({ id: `t${i}`, eventId: `ev-${i}` }),
    );
    scopedRows(many);
    const res = await service.getMyTickets('user-1');
    expect(res.truncated).toBe(true);
    // Borné à MAX événements distincts (1 billet chacun ici).
    expect(res.upcoming).toHaveLength(MY_TICKETS_MAX_PER_SCOPE);
  });

  it('plusieurs billets du même événement → une entrée, tous les billets dedans', async () => {
    scopedRows([
      row({ id: 't1', eventId: 'ev-1' }),
      row({ id: 't2', eventId: 'ev-1' }),
      row({ id: 't3', eventId: 'ev-1' }),
    ]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming).toHaveLength(1);
    expect(res.upcoming[0].tickets.map((t) => t.id)).toEqual(['t1', 't2', 't3']);
  });

  it('mappe les champs billet (pas de qrToken) et posterUrl', async () => {
    scopedRows([row({ id: 't1' })]);
    const res = await service.getMyTickets('user-1');
    const evt = res.upcoming[0];
    expect(evt.event.posterUrl).toBe('poster-url');
    expect(evt.tickets[0]).toEqual({
      id: 't1',
      categoryName: 'VIP',
      qrStatus: 'UNUSED',
      expiresAt: expect.any(Date),
      cancelledAt: null,
      ticketDesignUrl: 'design-url',
    });
    expect(evt.tickets[0]).not.toHaveProperty('qrToken');
  });

  it('poster absent → posterUrl null', async () => {
    scopedRows([row({ id: 't1', mediaFiles: [] })]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming[0].event.posterUrl).toBeNull();
  });

  it('range chaque scope dans son groupe', async () => {
    scopedRows([row({ id: 'fut', eventId: 'ev-fut' })], [row({ id: 'pas', eventId: 'ev-pas' })]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming.map((e) => e.event.id)).toEqual(['ev-fut']);
    expect(res.past.map((e) => e.event.id)).toEqual(['ev-pas']);
  });

  // --- Règles déléguées à SQL (assertion des arguments de findMany) ---

  it('scope upcoming : where = user + 24h + endDate futur, tri startDate asc', async () => {
    await service.getMyTickets('user-1');
    const args = prisma.ticket.findMany.mock.calls
      .map((c) => c[0])
      .find(isUpcomingArgs);

    // Ne charge que les billets de cet utilisateur, hors billets offerts (onglet dédié).
    expect(args.where.order).toEqual({ userId: 'user-1', paymentStatus: { not: 'GIFT' } });
    // Règle des 24h : non annulé OU annulé depuis moins de 24h.
    expect(args.where.OR[0]).toEqual({ qrStatus: { not: 'CANCELLED' } });
    const cutoff = args.where.OR[1].cancelledAt.gte.getTime();
    const nowUsed = args.where.ticketCategory.event.endDate.gte.getTime();
    expect(nowUsed - cutoff).toBe(DAY); // cutoff = now − 24h
    // Tri : le plus proche d'abord.
    expect(args.orderBy[0].ticketCategory.event.startDate).toBe('asc');
  });

  it('scope past : where endDate passé, tri startDate desc', async () => {
    await service.getMyTickets('user-1');
    const args = prisma.ticket.findMany.mock.calls
      .map((c) => c[0])
      .find((a) => !isUpcomingArgs(a));

    expect(args.where.order).toEqual({ userId: 'user-1', paymentStatus: { not: 'GIFT' } });
    expect(args.where.ticketCategory.event.endDate.lt).toBeInstanceOf(Date);
    // Tri : le plus récent d'abord.
    expect(args.orderBy[0].ticketCategory.event.startDate).toBe('desc');
  });

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
      await expect(service.getQrToken('intrus', 't1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('getTicketForRender', () => {
    it('non-propriétaire → 404', async () => {
      prisma.ticket.findFirst.mockResolvedValue(null);
      await expect(service.getTicketForRender('intrus', 't1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getMyGifts', () => {
    it('billets normaux exclus des onglets upcoming/past (filtre paymentStatus != GIFT)', async () => {
      await service.getMyTickets('user-1');
      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where.order).toEqual({ userId: 'user-1', paymentStatus: { not: 'GIFT' } });
    });

    it('offerts visibles : UNUSED + giftDownloadedAt null, groupés par événement', async () => {
      prisma.ticket.findMany.mockResolvedValueOnce([row({ id: 'g1', categoryName: 'Standard' })]);
      const res = await service.getMyGifts('user-1');
      const args = prisma.ticket.findMany.mock.calls[0][0];
      expect(args.where).toEqual(
        expect.objectContaining({
          order: { userId: 'user-1', paymentStatus: 'GIFT' },
          qrStatus: 'UNUSED',
          giftDownloadedAt: null,
        }),
      );
      expect(res.events).toHaveLength(1);
      expect(res.events[0].tickets[0].id).toBe('g1');
    });

    it('aucun offert visible → { events: [] }', async () => {
      prisma.ticket.findMany.mockResolvedValueOnce([]);
      const res = await service.getMyGifts('user-1');
      expect(res).toEqual({ events: [] });
    });
  });
});
