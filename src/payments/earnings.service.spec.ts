import { EarningsService } from './earnings.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { USD_TO_CDF_RATE } from 'src/common/constants';

describe('EarningsService', () => {
  let service: EarningsService;
  let prisma: {
    ledgerEntry: { aggregate: jest.Mock; findMany: jest.Mock };
    order: { aggregate: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      ledgerEntry: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { amount: null } }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      order: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { totalAmount: null, platformFee: null, organizerAmount: null },
        }),
      },
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

      expect(res).toEqual({
        availableBalanceUSD: 170,
        availableBalanceCDF: Math.round(170 * USD_TO_CDF_RATE),
        grossSoldUSD: 200,
        platformFeeUSD: 30,
        netEarnedUSD: 170,
        rate: USD_TO_CDF_RATE,
      });
    });

    it('aucune vente → tout à zéro (agrégats nuls)', async () => {
      const res = await service.getSummary('org-1');
      expect(res).toEqual({
        availableBalanceUSD: 0,
        availableBalanceCDF: 0,
        grossSoldUSD: 0,
        platformFeeUSD: 0,
        netEarnedUSD: 0,
        rate: USD_TO_CDF_RATE,
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
});
