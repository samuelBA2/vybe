import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { USD_TO_CDF_RATE } from 'src/common/constants';
import { buildPage, KeysetCursor, Paginated } from 'src/common/pagination';

const round2 = (n: number) => Math.round(n * 100) / 100;

// Comptabilité organisateur (lecture seule V1). Le ledger est la SOURCE DE VÉRITÉ
// des soldes ; les agrégats de commandes servent la ventilation (brut/commission/net).
// Affichage CDF converti au taux figé USD_TO_CDF_RATE. Le retrait (payout) = Lot 2.
@Injectable()
export class EarningsService {
  constructor(private readonly prisma: PrismaService) {}

  // Solde disponible (= net 85 % cumulé, ce que l'organisateur pourra retirer au
  // Lot 2) + ventilation brut / commission / net. Scope strict à l'utilisateur.
  async getSummary(userId: string) {
    // Solde = Σ des écritures ORGANIZER de l'utilisateur (source de vérité).
    const balance = await this.prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: { userId, account: 'ORGANIZER' },
    });

    // Ventilation depuis les commandes PAID des événements créés par l'utilisateur.
    const sold = await this.prisma.order.aggregate({
      _sum: { totalAmount: true, platformFee: true, organizerAmount: true },
      where: {
        paymentStatus: 'PAID',
        ticketCategory: { event: { createdById: userId } },
      },
    });

    const availableBalanceUSD = round2(balance._sum.amount ?? 0);
    const grossSoldUSD = round2(sold._sum.totalAmount ?? 0);
    const platformFeeUSD = round2(sold._sum.platformFee ?? 0);
    const netEarnedUSD = round2(sold._sum.organizerAmount ?? 0);

    return {
      availableBalanceUSD,
      availableBalanceCDF: Math.round(availableBalanceUSD * USD_TO_CDF_RATE),
      grossSoldUSD,
      platformFeeUSD,
      netEarnedUSD,
      rate: USD_TO_CDF_RATE,
    };
  }

  // Historique des écritures ORGANIZER (ventes créditées), tri chronologique
  // décroissant, pagination keyset sur (createdAt desc, id desc).
  async getHistory(
    userId: string,
    limit: number,
    cursor: KeysetCursor | null,
  ): Promise<Paginated<unknown>> {
    const rows = await this.prisma.ledgerEntry.findMany({
      where: {
        userId,
        account: 'ORGANIZER',
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.v) } },
                { createdAt: new Date(cursor.v), id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        type: true,
        amount: true,
        currency: true,
        orderId: true,
        eventId: true,
        createdAt: true,
      },
    });

    return buildPage(rows, limit, (r) => ({
      v: r.createdAt.toISOString(),
      id: r.id,
    }));
  }
}
