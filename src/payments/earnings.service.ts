import { Injectable } from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  PAYOUT_MATURATION_DAYS,
  PLATFORM_FEE_RATE,
  USD_TO_CDF_RATE,
} from 'src/common/constants';
import { buildPage, KeysetCursor, Paginated } from 'src/common/pagination';
import { payoutBounds } from 'src/common/money';

const round2 = (n: number) => Math.round(n * 100) / 100;
const MATURATION_MS = PAYOUT_MATURATION_DAYS * 24 * 60 * 60 * 1000;

// Quantifie un montant dans sa devise : CDF en entiers (le fournisseur refuse les
// décimales), USD à 2 décimales.
const quantize = (n: number, currency: $Enums.Currency) =>
  currency === 'CDF' ? Math.round(n) : round2(n);

// Devises supportées (ordre stable pour getWithdrawableAll / l'UI).
const CURRENCIES: $Enums.Currency[] = ['USD', 'CDF'];

// Comptabilité organisateur (lecture seule V1). Le ledger est la SOURCE DE VÉRITÉ
// des soldes ; les agrégats de commandes servent la ventilation (brut/commission/net).
// MULTI-DEVISES : un organisateur peut détenir un solde USD ET un solde CDF, jamais
// sommés entre eux (chaque devise se retire séparément). Le retrait (payout) = Lot 2.
@Injectable()
export class EarningsService {
  constructor(private readonly prisma: PrismaService) {}

  // Solde PAR DEVISE : une entrée par devise ayant de l'activité (solde ledger OU
  // ventes), avec balance + ventilation brut/commission/net + retirable. JAMAIS de
  // somme inter-devises. Scope strict à l'utilisateur.
  async getSummary(userId: string) {
    // Solde = Σ des écritures ORGANIZER de l'utilisateur, groupé par devise.
    const balanceGroups = await this.prisma.ledgerEntry.groupBy({
      by: ['currency'],
      _sum: { amount: true },
      where: { userId, account: 'ORGANIZER' },
    });

    // Ventilation depuis les commandes PAID des événements créés par l'utilisateur,
    // groupée par devise (Order.currency = event.priceCurrency depuis T3).
    const soldGroups = await this.prisma.order.groupBy({
      by: ['currency'],
      _sum: { totalAmount: true, platformFee: true, organizerAmount: true },
      where: {
        paymentStatus: 'PAID',
        ticketCategory: { event: { createdById: userId } },
      },
    });

    // Union des devises ayant de l'activité (solde ou ventes).
    const currencies = CURRENCIES.filter(
      (c) =>
        balanceGroups.some((g) => g.currency === c) ||
        soldGroups.some((g) => g.currency === c),
    );

    const cutoff = new Date(Date.now() - MATURATION_MS);

    const balances = await Promise.all(
      currencies.map(async (currency) => {
        const bal = balanceGroups.find((g) => g.currency === currency);
        const sold = soldGroups.find((g) => g.currency === currency);
        const { withdrawable } = await this.getWithdrawable(userId, currency);
        const { maturingAmount, nextMaturesAt } = await this.getNextMaturation(
          userId,
          currency,
          cutoff,
        );
        return {
          currency,
          balance: quantize(bal?._sum.amount ?? 0, currency),
          gross: quantize(sold?._sum.totalAmount ?? 0, currency),
          commission: quantize(sold?._sum.platformFee ?? 0, currency),
          net: quantize(sold?._sum.organizerAmount ?? 0, currency),
          withdrawable,
          // Seuil minimum de retrait DANS cette devise (front : « Retrait dès X »).
          minWithdrawal: payoutBounds(currency).min,
          // Fonds encore en maturation + date de déblocage de la plus ancienne
          // vente non maturée (front : « le reste dispo le … »). null si tout est mûr.
          maturingAmount,
          nextMaturesAt,
        };
      }),
    );

    return { balances };
  }

  // Fonds de vente PAS ENCORE maturés d'une devise (createdAt > cutoff) : leur
  // montant + la date de maturation de la PLUS ANCIENNE vente en attente
  // (createdAt + délai). Sert l'affichage « le reste dispo le … » côté wallet.
  private async getNextMaturation(
    userId: string,
    currency: $Enums.Currency,
    cutoff: Date,
  ): Promise<{ maturingAmount: number; nextMaturesAt: string | null }> {
    const pending = await this.prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      _min: { createdAt: true },
      where: {
        userId,
        account: 'ORGANIZER',
        type: 'SALE_ORGANIZER',
        currency,
        createdAt: { gt: cutoff },
      },
    });
    const earliest = pending._min.createdAt;
    return {
      maturingAmount: quantize(pending._sum.amount ?? 0, currency),
      nextMaturesAt: earliest
        ? new Date(earliest.getTime() + MATURATION_MS).toISOString()
        : null,
    };
  }

  // Solde RETIRABLE d'UNE devise (≠ solde total créance). Seules les ventes
  // maturées comptent côté crédit ; les payouts (débits + reversals) comptent
  // immédiatement. Un débit est donc toujours adossé à du crédit maturé. Jamais < 0.
  async getWithdrawable(
    userId: string,
    currency: $Enums.Currency,
  ): Promise<{ currency: $Enums.Currency; withdrawable: number }> {
    const cutoff = new Date(
      Date.now() - PAYOUT_MATURATION_DAYS * 24 * 60 * 60 * 1000,
    );

    const maturedCredits = await this.prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: {
        userId,
        account: 'ORGANIZER',
        type: 'SALE_ORGANIZER',
        currency,
        createdAt: { lte: cutoff },
      },
    });

    const payouts = await this.prisma.ledgerEntry.aggregate({
      _sum: { amount: true },
      where: {
        userId,
        account: 'ORGANIZER',
        type: { in: ['PAYOUT_ORGANIZER', 'PAYOUT_REVERSAL'] },
        currency,
      },
    });

    const raw = (maturedCredits._sum.amount ?? 0) + (payouts._sum.amount ?? 0);
    return { currency, withdrawable: Math.max(0, quantize(raw, currency)) };
  }

  // Retirable des DEUX devises (pour l'UI : affiche USD et CDF séparément).
  async getWithdrawableAll(
    userId: string,
  ): Promise<{ currency: $Enums.Currency; withdrawable: number }[]> {
    return Promise.all(CURRENCIES.map((c) => this.getWithdrawable(userId, c)));
  }

  // Recettes PAR ÉVÉNEMENT (lecture seule). Order n'a pas d'eventId : on agrège
  // les commandes PAID par ticketCategoryId (une requête), puis on regroupe
  // catégorie→événement en mémoire. Chaque événement porte SA devise
  // (event.priceCurrency) ; les montants sont déjà dans cette devise (Order.currency
  // = event.priceCurrency depuis T3) → aucune conversion. La réponse porte aussi le
  // détail par catégorie → sert la liste ET le drill-down sans second appel.
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
        priceCurrency: true,
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
        currency: e.priceCurrency,
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
