import { EarningsService } from './earnings.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PLATFORM_FEE_RATE } from 'src/common/constants';

describe('EarningsService', () => {
  let service: EarningsService;
  let prisma: {
    ledgerEntry: {
      aggregate: jest.Mock;
      groupBy: jest.Mock;
      findMany: jest.Mock;
    };
    order: { aggregate: jest.Mock; groupBy: jest.Mock };
    event: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      ledgerEntry: {
        aggregate: jest.fn().mockImplementation((args: any) => {
          const cur = args?.where?.currency;
          if (args?.where?.type === 'SALE_ORGANIZER') {
            // Ventes NON maturées (createdAt > cutoff) : par défaut aucune.
            if (args?.where?.createdAt?.gt) {
              return Promise.resolve({
                _sum: { amount: null },
                _min: { createdAt: null },
              });
            }
            // Crédits de vente maturés (createdAt ≤ cutoff).
            return Promise.resolve({
              _sum: { amount: cur === 'CDF' ? 300000 : 100 },
            });
          }
          return Promise.resolve({ _sum: { amount: null } });
        }),
        // Solde ORGANIZER groupé par devise (getSummary).
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
      order: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { totalAmount: null, platformFee: null, organizerAmount: null },
        }),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      event: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new EarningsService(prisma as unknown as PrismaService);
  });

  describe('getSummary', () => {
    it('renvoie un solde PAR DEVISE (jamais sommé) : balance + brut/commission/net', async () => {
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        { currency: 'USD', _sum: { amount: 170 } },
        { currency: 'CDF', _sum: { amount: 400000 } },
      ]);
      prisma.order.groupBy.mockResolvedValue([
        {
          currency: 'USD',
          _sum: { totalAmount: 200, platformFee: 30, organizerAmount: 170 },
        },
        {
          currency: 'CDF',
          _sum: {
            totalAmount: 500000,
            platformFee: 100000,
            organizerAmount: 400000,
          },
        },
      ]);

      const res = await service.getSummary('org-1');

      // Solde groupé par devise sur le ledger ORGANIZER de l'utilisateur.
      expect(prisma.ledgerEntry.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['currency'],
          _sum: { amount: true },
          where: { userId: 'org-1', account: 'ORGANIZER' },
        }),
      );
      // Brut/commission/net groupés par devise sur les commandes PAID de l'orga.
      expect(prisma.order.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['currency'],
          where: {
            paymentStatus: 'PAID',
            ticketCategory: { event: { createdById: 'org-1' } },
          },
        }),
      );

      // Une entrée par devise (USD et CDF), jamais sommées.
      expect(res.balances).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ currency: 'USD' }),
          expect.objectContaining({ currency: 'CDF' }),
        ]),
      );
      const usd = res.balances.find((b) => b.currency === 'USD');
      const cdf = res.balances.find((b) => b.currency === 'CDF');
      expect(usd).toEqual({
        currency: 'USD',
        balance: 170,
        gross: 200,
        commission: 30,
        net: 170,
      });
      expect(cdf).toEqual({
        currency: 'CDF',
        balance: 400000,
        gross: 500000,
        commission: 100000,
        net: 400000,
      });
      // Plus de champs mono-devise / taux.
      expect(res).not.toHaveProperty('availableBalanceUSD');
      expect(res).not.toHaveProperty('rate');
    });

    it('aucune activité → liste de soldes vide', async () => {
      const res = await service.getSummary('org-1');
      expect(res.balances).toEqual([]);
    });
  });

  describe('getHistory', () => {
    it('ledger ORGANIZER trié createdAt desc, keyset paginé (nextCursor si page suivante)', async () => {
      const rows = [
        { id: 'l1', type: 'SALE_ORGANIZER', amount: 170, currency: 'USD', orderId: 'o1', eventId: 'e1', createdAt: new Date('2026-09-03T10:00:00Z') },
        { id: 'l2', type: 'SALE_ORGANIZER', amount: 42.5, currency: 'USD', orderId: 'o2', eventId: 'e1', createdAt: new Date('2026-09-02T10:00:00Z') },
        { id: 'l3', type: 'SALE_ORGANIZER', amount: 10, currency: 'USD', orderId: 'o3', eventId: 'e2', createdAt: new Date('2026-09-01T10:00:00Z') },
      ];
      prisma.ledgerEntry.findMany.mockResolvedValue(rows); // limit=2 → 3 lignes = page suivante

      const res = await service.getHistory('org-1', 2, null);

      expect(prisma.ledgerEntry.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'org-1', account: 'ORGANIZER' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 3, // limit + 1
      }));
      expect(res.items).toHaveLength(2);
      expect(res.nextCursor).not.toBeNull();
    });

    it('curseur keyset appliqué (createdAt/id) quand fourni', async () => {
      prisma.ledgerEntry.findMany.mockResolvedValue([]);
      await service.getHistory('org-1', 20, { v: '2026-09-02T10:00:00.000Z', id: 'l2' });
      const arg = prisma.ledgerEntry.findMany.mock.calls[0][0];
      expect(arg.where).toEqual(expect.objectContaining({
        userId: 'org-1',
        account: 'ORGANIZER',
        OR: [
          { createdAt: { lt: new Date('2026-09-02T10:00:00.000Z') } },
          { createdAt: new Date('2026-09-02T10:00:00.000Z'), id: { lt: 'l2' } },
        ],
      }));
    });
  });

  describe('getEventsBreakdown', () => {
    it('agrège par événement via catégories (PAID only), net=85 %, revenu par catégorie, devise par event, scope createdById', async () => {
      prisma.event.findMany.mockResolvedValue([
        {
          reference: 'evt_1',
          title: 'Soirée',
          startDate: new Date('2026-10-02T20:00:00.000Z'),
          status: 'PUBLISHED',
          priceCurrency: 'USD',
          ticketCategories: [
            { id: 'c1', name: 'Standard' },
            { id: 'c2', name: 'VIP' },
          ],
          mediaFiles: [{ url: 'https://poster/1.jpg' }],
        },
        {
          reference: 'evt_2',
          title: 'Sans vente',
          startDate: new Date('2026-11-01T18:00:00.000Z'),
          status: 'PUBLISHED',
          priceCurrency: 'CDF',
          ticketCategories: [{ id: 'c3', name: 'Base' }],
          mediaFiles: [],
        },
      ]);
      prisma.order.groupBy.mockResolvedValue([
        { ticketCategoryId: 'c1', _sum: { totalAmount: 80, platformFee: 12, organizerAmount: 68, quantity: 8 }, _count: 5 },
        { ticketCategoryId: 'c2', _sum: { totalAmount: 20, platformFee: 3, organizerAmount: 17, quantity: 2 }, _count: 2 },
        // c3 absent → événement 2 sans vente
      ]);

      const res = await service.getEventsBreakdown('org-1');

      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            createdById: 'org-1',
            status: { in: ['PUBLISHED', 'CLOSED'] },
          },
        }),
      );
      expect(prisma.order.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['ticketCategoryId'],
          where: { paymentStatus: 'PAID', ticketCategoryId: { in: ['c1', 'c2', 'c3'] } },
        }),
      );

      expect(res.platformFeeRate).toBe(PLATFORM_FEE_RATE);
      expect(res.events).toEqual([
        {
          reference: 'evt_1',
          title: 'Soirée',
          startDate: new Date('2026-10-02T20:00:00.000Z'),
          posterUrl: 'https://poster/1.jpg',
          status: 'PUBLISHED',
          currency: 'USD',
          gross: 100,
          commission: 15,
          net: 85,
          soldTickets: 10,
          paidOrders: 7,
          categories: [
            { id: 'c1', name: 'Standard', soldTickets: 8, revenue: 80 },
            { id: 'c2', name: 'VIP', soldTickets: 2, revenue: 20 },
          ],
        },
        {
          reference: 'evt_2',
          title: 'Sans vente',
          startDate: new Date('2026-11-01T18:00:00.000Z'),
          posterUrl: null,
          status: 'PUBLISHED',
          currency: 'CDF',
          gross: 0,
          commission: 0,
          net: 0,
          soldTickets: 0,
          paidOrders: 0,
          categories: [{ id: 'c3', name: 'Base', soldTickets: 0, revenue: 0 }],
        },
      ]);
    });

    it('aucun événement → liste vide, groupBy non appelé', async () => {
      prisma.event.findMany.mockResolvedValue([]);
      const res = await service.getEventsBreakdown('org-1');
      expect(res.events).toEqual([]);
      expect(prisma.order.groupBy).not.toHaveBeenCalled();
    });
  });
});
