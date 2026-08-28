import { NotFoundException } from '@nestjs/common';
import { MyTicketsService } from './MyTickets.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('MyTicketsService', () => {
  let service: MyTicketsService;
  let prisma: { ticket: { findMany: jest.Mock; findFirst: jest.Mock } };
  let ticketAssets: { regenerateMissingForUser: jest.Mock };

  beforeEach(() => {
    prisma = {
      ticket: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn() },
    };
    ticketAssets = { regenerateMissingForUser: jest.fn().mockResolvedValue(undefined) };
    service = new MyTicketsService(
      prisma as unknown as PrismaService,
      ticketAssets as any,
    );
  });

  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const now = Date.now();

  // Ligne Ticket telle que renvoyée par findMany (déjà filtrée/triée par SQL).
  const row = (over: any = {}) => ({
    id: over.id ?? 't1',
    qrStatus: over.qrStatus ?? 'UNUSED',
    ticketImageUrl: 'ticketImageUrl' in over ? over.ticketImageUrl : 'png-url',
    pdfUrl: 'pdfUrl' in over ? over.pdfUrl : 'pdf-url',
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
    expect(res).toEqual({ upcoming: [], past: [] });
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
      ticketImageUrl: 'png-url',
      pdfUrl: 'pdf-url',
      expiresAt: expect.any(Date),
      cancelledAt: null,
      ticketDesignUrl: 'design-url',
    });
    expect(evt.tickets[0]).not.toHaveProperty('qrToken');
  });

  it('poster absent → posterUrl null ; visuels non générés → urls null', async () => {
    scopedRows([row({ id: 't1', mediaFiles: [], ticketImageUrl: null, pdfUrl: null })]);
    const res = await service.getMyTickets('user-1');
    expect(res.upcoming[0].event.posterUrl).toBeNull();
    expect(res.upcoming[0].tickets[0].ticketImageUrl).toBeNull();
    expect(res.upcoming[0].tickets[0].pdfUrl).toBeNull();
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

    // Ne charge que les billets de cet utilisateur.
    expect(args.where.order).toEqual({ userId: 'user-1' });
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

    expect(args.where.order).toEqual({ userId: 'user-1' });
    expect(args.where.ticketCategory.event.endDate.lt).toBeInstanceOf(Date);
    // Tri : le plus récent d'abord.
    expect(args.orderBy[0].ticketCategory.event.startDate).toBe('desc');
  });

  // --- Rattrapage des visuels (fire-and-forget) ---

  describe('rattrapage des visuels', () => {
    it('déclenche regenerateMissingForUser quand un billet a une URL null', async () => {
      scopedRows([row({ id: 't1', ticketImageUrl: null })]);
      await service.getMyTickets('user-1');
      expect(ticketAssets.regenerateMissingForUser).toHaveBeenCalledWith('user-1');
    });

    it('ne déclenche rien quand tous les visuels sont présents', async () => {
      scopedRows([row({ id: 't1' })]); // urls par défaut = 'png-url' / 'pdf-url'
      await service.getMyTickets('user-1');
      expect(ticketAssets.regenerateMissingForUser).not.toHaveBeenCalled();
    });

    it('non-bloquant : un rejet du rattrapage ne casse pas la lecture', async () => {
      scopedRows([row({ id: 't1', pdfUrl: null })]);
      ticketAssets.regenerateMissingForUser.mockRejectedValue(new Error('KO'));
      await expect(service.getMyTickets('user-1')).resolves.toBeDefined();
    });
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
});
