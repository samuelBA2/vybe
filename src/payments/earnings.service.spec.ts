import { EarningsService } from './earnings.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PAYOUT_MATURATION_DAYS, PLATFORM_FEE_RATE } from 'src/common/constants';

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
        // Agrégats de getWithdrawable : distingués par devise (args.where.currency).
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
          // Débits/reversals de payout (PAYOUT_ORGANIZER + PAYOUT_REVERSAL).
          if (args?.where?.type?.in) {
            return Promise.resolve({
              _sum: { amount: cur === 'CDF' ? -50000 : -30 },
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
    it('renvoie un solde PAR DEVISE (jamais sommé) : balance + brut/commission/net + retirable', async () => {
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
      // USD : withdrawable = 100 (maturé) − 30 (payouts) = 70 ; min 2 USD ; rien en maturation.
      expect(usd).toEqual({
        currency: 'USD',
        balance: 170,
        gross: 200,
        commission: 30,
        net: 170,
        withdrawable: 70,
        minWithdrawal: 2,
        maturingAmount: 0,
        nextMaturesAt: null,
      });
      // CDF (entiers) : withdrawable = 300000 − 50000 = 250000 ; min 4500 CDF (2 USD × 2250).
      expect(cdf).toEqual({
        currency: 'CDF',
        balance: 400000,
        gross: 500000,
        commission: 100000,
        net: 400000,
        withdrawable: 250000,
        minWithdrawal: 4500,
        maturingAmount: 0,
        nextMaturesAt: null,
      });
      // Plus de champs mono-devise / taux.
      expect(res).not.toHaveProperty('availableBalanceUSD');
      expect(res).not.toHaveProperty('rate');
    });

    it('aucune activité → liste de soldes vide', async () => {
      const res = await service.getSummary('org-1');
      expect(res.balances).toEqual([]);
    });

    it('expose minWithdrawal + maturingAmount + date de maturation quand une vente est encore en maturation', async () => {
      prisma.ledgerEntry.groupBy.mockResolvedValue([
        { currency: 'CDF', _sum: { amount: 2500 } },
      ]);
      prisma.order.groupBy.mockResolvedValue([
        { currency: 'CDF', _sum: { totalAmount: 2500, platformFee: 500, organizerAmount: 2000 } },
      ]);
      // Vente CDF non maturée : créée il y a 2 jours (createdAt > cutoff).
      const soldAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      prisma.ledgerEntry.aggregate.mockImplementation((args: any) => {
        if (args?.where?.type === 'SALE_ORGANIZER') {
          if (args?.where?.createdAt?.gt) {
            return Promise.resolve({ _sum: { amount: 2000 }, _min: { createdAt: soldAt } });
          }
          return Promise.resolve({ _sum: { amount: null } }); // rien de maturé
        }
        if (args?.where?.type?.in) return Promise.resolve({ _sum: { amount: null } });
        return Promise.resolve({ _sum: { amount: null } });
      });

      const res = await service.getSummary('org-1');
      const cdf = res.balances.find((b) => b.currency === 'CDF')!;

      expect(cdf.withdrawable).toBe(0); // rien de maturé encore
      expect(cdf.minWithdrawal).toBe(4500);
      expect(cdf.maturingAmount).toBe(2000);
      // Déblocage = createdAt de la vente + PAYOUT_MATURATION_DAYS.
      expect(cdf.nextMaturesAt).toBe(
        new Date(soldAt.getTime() + PAYOUT_MATURATION_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      );
    });
  });

  describe('getWithdrawable', () => {
    it('retirable CDF : crédits maturés − payouts nets, filtré par devise, entier', async () => {
      const before = Date.now() - PAYOUT_MATURATION_DAYS * 24 * 60 * 60 * 1000;
      const res = await service.getWithdrawable('org-1', 'CDF');
      const after = Date.now() - PAYOUT_MATURATION_DAYS * 24 * 60 * 60 * 1000;

      // Crédits maturés : SALE_ORGANIZER, scope user, devise CDF, createdAt ≤ cutoff.
      const creditCall = prisma.ledgerEntry.aggregate.mock.calls.find(
        (c: any[]) => c[0]?.where?.type === 'SALE_ORGANIZER',
      );
      expect(creditCall[0].where.userId).toBe('org-1');
      expect(creditCall[0].where.account).toBe('ORGANIZER');
      expect(creditCall[0].where.currency).toBe('CDF');
      expect(creditCall[0].where.createdAt.lte).toBeInstanceOf(Date);
      const cutoffMs = creditCall[0].where.createdAt.lte.getTime();
      expect(cutoffMs).toBeGreaterThanOrEqual(before);
      expect(cutoffMs).toBeLessThanOrEqual(after);

      // Payouts : PAYOUT_ORGANIZER + PAYOUT_REVERSAL, filtrés CDF.
      const payoutCall = prisma.ledgerEntry.aggregate.mock.calls.find(
        (c: any[]) => c[0]?.where?.type?.in,
      );
      expect(payoutCall[0].where.type.in).toEqual([
        'PAYOUT_ORGANIZER',
        'PAYOUT_REVERSAL',
      ]);
      expect(payoutCall[0].where.currency).toBe('CDF');

      // 300000 (maturé) + (−50000 payouts) = 250000.
      expect(res).toEqual({ currency: 'CDF', withdrawable: 250000 });
    });

    it('retirable USD : round2, filtré par devise', async () => {
      const res = await service.getWithdrawable('org-1', 'USD');
      // 100 (maturé) − 30 (payouts) = 70.
      expect(res).toEqual({ currency: 'USD', withdrawable: 70 });
    });

    it('ne descend jamais sous 0', async () => {
      prisma.ledgerEntry.aggregate.mockImplementation((args: any) => {
        if (args?.where?.type === 'SALE_ORGANIZER')
          return Promise.resolve({ _sum: { amount: 10 } });
        if (args?.where?.type?.in)
          return Promise.resolve({ _sum: { amount: -25 } });
        return Promise.resolve({ _sum: { amount: null } });
      });
      const res = await service.getWithdrawable('org-1', 'USD');
      expect(res.withdrawable).toBe(0);
    });
  });

  describe('getWithdrawableAll', () => {
    it('renvoie le retirable des DEUX devises', async () => {
      const res = await service.getWithdrawableAll('org-1');
      expect(res).toEqual([
        { currency: 'USD', withdrawable: 70 },
        { currency: 'CDF', withdrawable: 250000 },
      ]);
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
