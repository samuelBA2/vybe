import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PLATFORM_FEE_RATE, USD_TO_CDF_RATE } from 'src/common/constants';
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

  // Recettes PAR ÉVÉNEMENT (lecture seule). Order n'a pas d'eventId : on agrège
  // les commandes PAID par ticketCategoryId (une requête), puis on regroupe
  // catégorie→événement en mémoire. Montants USD (base comptable) ; le front
  // affiche le CDF via usdToCdfRate. La réponse porte aussi le détail par
  // catégorie → sert la liste ET le drill-down sans second appel.
  async getEventsBreakdown(userId: string) {
    const events = await this.prisma.event.findMany({
      // Scope strict à l'organisateur, limité aux statuts comptables :
      // PUBLISHED (en vente) et CLOSED (terminé). Les brouillons, événements
      // en revue, refusés ou annulés n'ont pas de recettes à afficher.
      where: { createdById: userId, status: { in: ['PUBLISHED', 'CLOSED'] } },
      orderBy: { startDate: 'desc' },
      select: {
        reference: true,
        title: true,
        startDate: true,
        status: true,
        ticketCategories: { select: { id: true, name: true } },
        mediaFiles: {
          where: { isPoster: true },
          select: { url: true },
          take: 1,
        },
      },
    });

    const allCatIds = events.flatMap((e) =>
      e.ticketCategories.map((c) => c.id),
    );

    // Agrégats des commandes PAID par catégorie (une seule requête).
    const grouped = allCatIds.length
      ? await this.prisma.order.groupBy({
          by: ['ticketCategoryId'],
          where: { paymentStatus: 'PAID', ticketCategoryId: { in: allCatIds } },
          _sum: {
            totalAmount: true,
            platformFee: true,
            organizerAmount: true,
            quantity: true,
          },
          _count: true,
        })
      : [];

    const byCat = new Map<
      string,
      {
        gross: number;
        commission: number;
        net: number;
        soldTickets: number;
        paidOrders: number;
      }
    >();
    for (const g of grouped) {
      byCat.set(g.ticketCategoryId, {
        gross: g._sum.totalAmount ?? 0,
        commission: g._sum.platformFee ?? 0,
        net: g._sum.organizerAmount ?? 0,
        soldTickets: g._sum.quantity ?? 0,
        paidOrders: g._count,
      });
    }

    const eventsOut = events.map((e) => {
      let gross = 0;
      let commission = 0;
      let net = 0;
      let soldTickets = 0;
      let paidOrders = 0;
      const categories = e.ticketCategories.map((c) => {
        const a = byCat.get(c.id);
        if (a) {
          gross += a.gross;
          commission += a.commission;
          net += a.net;
          soldTickets += a.soldTickets;
          paidOrders += a.paidOrders;
        }
        return {
          id: c.id,
          name: c.name,
          soldTickets: a?.soldTickets ?? 0,
          revenue: round2(a?.gross ?? 0),
        };
      });
      return {
        reference: e.reference,
        title: e.title,
        startDate: e.startDate,
        posterUrl: e.mediaFiles[0]?.url ?? null,
        status: e.status,
        gross: round2(gross),
        commission: round2(commission),
        net: round2(net),
        soldTickets,
        paidOrders,
        categories,
      };
    });

    return {
      usdToCdfRate: USD_TO_CDF_RATE,
      platformFeeRate: PLATFORM_FEE_RATE,
      events: eventsOut,
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
