import { EarningsService } from './earnings.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  PAYOUT_MATURATION_DAYS,
  PLATFORM_FEE_RATE,
  USD_TO_CDF_RATE,
} from 'src/common/constants';

describe('EarningsService', () => {
  let service: EarningsService;
  let prisma: {
    ledgerEntry: { aggregate: jest.Mock; findMany: jest.Mock };
    order: { aggregate: jest.Mock; groupBy: jest.Mock };
    event: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      ledgerEntry: {
        aggregate: jest.fn().mockImplementation((args: any) => {
          // Crédits de vente maturés (SALE_ORGANIZER + filtre createdAt).
          if (args?.where?.type === 'SALE_ORGANIZER') {
            return Promise.resolve({ _sum: { amount: 100 } });
          }
          // Débits/reversals de payout (PAYOUT_ORGANIZER + PAYOUT_REVERSAL).
          if (args?.where?.type?.in) {
            return Promise.resolve({ _sum: { amount: -30 } });
          }
          // getSummary : solde total ORGANIZER.
          return Promise.resolve({ _sum: { amount: null } });
        }),
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
    it('agrège le solde (ledger ORGANIZER) + brut/commission/net (Order PAID) + conversion CDF', async () => {
      prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount: 170 } });
      prisma.order.aggregate.mockResolvedValue({
        _sum: { totalAmount: 200, platformFee: 30, organizerAmount: 170 },
      });

      const res = await service.getSummary('org-1');

      // Solde disponible = Σ ledger ORGANIZER de l'utilisateur.
      expect(prisma.ledgerEntry.aggregate).toHaveBeenCalledWith(expect.objectContaining({
        _sum: { amount: true },
        where: { userId: 'org-1', account: 'ORGANIZER' },
      }));
      // Brut/commission/net = agrégats des commandes PAID des événements de l'orga.
      expect(prisma.order.aggregate).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          paymentStatus: 'PAID',
          ticketCategory: { event: { createdById: 'org-1' } },
        },
      }));

      // Le mock d'aggregate ci-dessus renvoie 170 sur tous les appels (y compris
      // ceux de getWithdrawable) : retirable = 170 (maturé) + 170 (payouts) = 340.
      expect(res).toEqual({
        availableBalanceUSD: 170,
        availableBalanceCDF: Math.round(170 * USD_TO_CDF_RATE),
        grossSoldUSD: 200,
        platformFeeUSD: 30,
        netEarnedUSD: 170,
        rate: USD_TO_CDF_RATE,
        withdrawableUSD: 340,
        withdrawableCDF: Math.round(340 * USD_TO_CDF_RATE),
      });
    });

    it('aucune vente → tout à zéro (agrégats nuls)', async () => {
      const res = await service.getSummary('org-1');
      // Solde total ORGANIZER nul, mais le mock par défaut du beforeEach
      // renvoie tout de même des crédits maturés (100) et des payouts (-30)
      // pour les appels dédiés de getWithdrawable → retirable = 70.
      expect(res).toEqual({
        availableBalanceUSD: 0,
        availableBalanceCDF: 0,
        grossSoldUSD: 0,
        platformFeeUSD: 0,
        netEarnedUSD: 0,
        rate: USD_TO_CDF_RATE,
        withdrawableUSD: 70,
        withdrawableCDF: Math.round(70 * USD_TO_CDF_RATE),
      });
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
    it('agrège par événement via catégories (PAID only), net=85 %, revenu par catégorie, scope createdById', async () => {
      prisma.event.findMany.mockResolvedValue([
        {
          reference: 'evt_1',
          title: 'Soirée',
          startDate: new Date('2026-10-02T20:00:00.000Z'),
          status: 'PUBLISHED',
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

      // Scope strict aux événements de l'organisateur, limité aux statuts
      // comptables (PUBLISHED/CLOSED) : brouillons, en revue, refusés et
      // annulés n'apparaissent pas dans la comptabilité.
      expect(prisma.event.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            createdById: 'org-1',
            status: { in: ['PUBLISHED', 'CLOSED'] },
          },
        }),
      );
      // Agrégat PAID uniquement, sur toutes les catégories des événements.
      expect(prisma.order.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          by: ['ticketCategoryId'],
          where: { paymentStatus: 'PAID', ticketCategoryId: { in: ['c1', 'c2', 'c3'] } },
        }),
      );

      expect(res.usdToCdfRate).toBe(USD_TO_CDF_RATE);
      expect(res.platformFeeRate).toBe(PLATFORM_FEE_RATE);
      expect(res.events).toEqual([
        {
          reference: 'evt_1',
          title: 'Soirée',
          startDate: new Date('2026-10-02T20:00:00.000Z'),
          posterUrl: 'https://poster/1.jpg',
          status: 'PUBLISHED',
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

  describe('getWithdrawable', () => {
    it('retirable = crédits maturés − payouts nets, scope user, CDF au taux', async () => {
      const before = Date.now() - PAYOUT_MATURATION_DAYS * 24 * 60 * 60 * 1000;
      const res = await service.getWithdrawable('org-1');
      const after = Date.now() - PAYOUT_MATURATION_DAYS * 24 * 60 * 60 * 1000;

      // Crédits maturés : SALE_ORGANIZER, scope user, createdAt ≤ cutoff.
      const creditCall = prisma.ledgerEntry.aggregate.mock.calls.find(
        (c: any[]) => c[0]?.where?.type === 'SALE_ORGANIZER',
      );
      expect(creditCall[0].where.userId).toBe('org-1');
      expect(creditCall[0].where.account).toBe('ORGANIZER');
      expect(creditCall[0].where.createdAt.lte).toBeInstanceOf(Date);
      // Cutoff = maintenant − PAYOUT_MATURATION_DAYS jours (encadré par before/after).
      const cutoffMs = creditCall[0].where.createdAt.lte.getTime();
      expect(cutoffMs).toBeGreaterThanOrEqual(before);
      expect(cutoffMs).toBeLessThanOrEqual(after);

      // Payouts : PAYOUT_ORGANIZER + PAYOUT_REVERSAL (pas de filtre maturation).
      const payoutCall = prisma.ledgerEntry.aggregate.mock.calls.find(
        (c: any[]) => c[0]?.where?.type?.in,
      );
      expect(payoutCall[0].where.type.in).toEqual([
        'PAYOUT_ORGANIZER',
        'PAYOUT_REVERSAL',
      ]);
      expect(payoutCall[0].where.userId).toBe('org-1');

      // 100 (maturé) + (−30 net payouts) = 70.
      expect(res.withdrawableUSD).toBe(70);
      expect(res.withdrawableCDF).toBe(Math.round(70 * USD_TO_CDF_RATE));
    });

    it('ne descend jamais sous 0', async () => {
      prisma.ledgerEntry.aggregate.mockImplementation((args: any) => {
        if (args?.where?.type === 'SALE_ORGANIZER')
          return Promise.resolve({ _sum: { amount: 10 } });
        if (args?.where?.type?.in)
          return Promise.resolve({ _sum: { amount: -25 } });
        return Promise.resolve({ _sum: { amount: null } });
      });
      const res = await service.getWithdrawable('org-1');
      expect(res.withdrawableUSD).toBe(0);
    });
  });

  it('getSummary expose aussi le solde retirable', async () => {
    const res = await service.getSummary('org-1');
    expect(res).toHaveProperty('withdrawableUSD');
    expect(res).toHaveProperty('withdrawableCDF');
  });
});
