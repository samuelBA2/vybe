import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import type {
  PaymentProvider,
  WebhookRequestContext,
} from './payment-provider.interface';

// Tolérance de comparaison des montants (USD à 2 décimales ; CDF entier). Au-delà,
// on considère qu'il y a divergence entre le montant confirmé et Σ chargedAmount.
const AMOUNT_EPSILON = 0.01; // USD 1 centime = CDF 22,50 (≈ 23 CDF)

// Résumé agrégé renvoyé au fournisseur (ACK 200) après traitement du callback.
type WebhookOutcome = 'PAID' | 'FAILED' | 'REVIEW' | 'PENDING';

// Forme (partielle) d'une commande chargée avec sa catégorie + événement.
type OrderWithEvent = {
  id: string;
  ticketCategoryId: string;
  quantity: number;
  chargedAmount: number;
  organizerAmount: number;
  platformFee: number;
  paymentStatus: string;
  ticketCategory: { event: { id: string; endDate: Date; createdById: string } };
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
  ) {}

  // Traite un callback fournisseur. On ne se fie JAMAIS au seul callback :
  // signature d'abord (fail-closed 401), puis re-vérification serveur via
  // checkStatus (= source de vérité), puis transition atomique + idempotente.
  async handleWebhook(
    rawBody: string,
    headers: Record<string, string>,
    context?: WebhookRequestContext,
  ): Promise<{ paymentRef: string; status: WebhookOutcome }> {
    // 1) Authenticité du callback (RFC-9421 côté PawaPay). Rejet = 401, on s'arrête.
    // `context` (méthode/chemin/authority) permet de vérifier une signature qui
    // couvre des composants dérivés (prod PawaPay).
    if (!this.payment.verifyWebhookSignature(rawBody, headers, context)) {
      throw new UnauthorizedException('Signature de webhook invalide.');
    }

    // 2) Extraire NOTRE référence (depositId = paymentRef partagé du checkout).
    let parsed: { depositId?: string };
    try {
      parsed = JSON.parse(rawBody) as { depositId?: string };
    } catch {
      throw new BadRequestException('Corps de webhook illisible.');
    }
    const paymentRef = parsed.depositId;
    if (!paymentRef) {
      throw new BadRequestException(
        'Référence de paiement absente du webhook.',
      );
    }

    // Trace d'audit (ne doit jamais casser le traitement).
    await this.log(paymentRef, rawBody);

    // 3) Re-vérification serveur = source de vérité.
    const check = await this.payment.checkStatus(paymentRef);

    // 4) Charger toutes les commandes du checkout (catégorie + événement).
    const orders = (await this.prisma.order.findMany({
      where: { paymentRef },
      include: { ticketCategory: { include: { event: true } } },
    })) as unknown as OrderWithEvent[];
    if (orders.length === 0) {
      throw new NotFoundException(
        'Aucune commande pour cette référence de paiement.',
      );
    }

    // Refusé : commandes PENDING → FAILED + stock relâché.
    if (check.status === 'DECLINED') {
      await this.fail(orders);
      return { paymentRef, status: 'FAILED' };
    }

    // Ni approuvé ni refusé (PROCESSING/NOT_FOUND) : on ne tranche pas.
    if (check.status !== 'APPROVED' && check.status !== 'ACCEPTED') {
      return { paymentRef, status: 'PENDING' };
    }

    // Approuvé : contrôle anti-divergence si le fournisseur expose le montant.
    const expectedCharged = orders.reduce((s, o) => s + o.chargedAmount, 0);
    if (
      check.amount !== undefined &&
      Math.abs(check.amount - expectedCharged) > AMOUNT_EPSILON
    ) {
      // Paiement accepté mais montant incohérent : résolution manuelle (jamais de
      // billet/ledger sur un montant douteux). Un paiement accepté ne reste jamais
      // sans résolution → REVIEW.
      await this.prisma.order.updateMany({
        where: { paymentRef, paymentStatus: { in: ['PENDING', 'EXPIRED'] } },
        data: { paymentStatus: 'REVIEW' },
      });
      this.logger.warn(
        `Divergence de montant (paymentRef=${paymentRef}) : confirmé=${check.amount} attendu=${expectedCharged} → REVIEW.`,
      );
      return { paymentRef, status: 'REVIEW' };
    }

    // Paiement confirmé conforme : générer billets + ledger, passer PAID.
    return { paymentRef, status: await this.fulfill(orders) };
  }

  // Transition PAID atomique de toutes les commandes du checkout. Idempotent :
  // les commandes déjà PAID sont ignorées. Une commande EXPIRED (stock relâché par
  // le reaper) est re-honorée si le stock est de nouveau disponible, sinon REVIEW.
  private async fulfill(orders: OrderWithEvent[]): Promise<WebhookOutcome> {
    let outcome: WebhookOutcome = 'PAID';
    await this.prisma.$transaction(async (tx) => {
      for (const order of orders) {
        if (order.paymentStatus === 'PAID') continue; // déjà honorée (idempotence)

        if (order.paymentStatus === 'EXPIRED') {
          // Le reaper a relâché le stock : tenter de le re-réserver.
          const affected = await tx.$executeRaw`
          UPDATE "TicketCategory"
          SET "soldCount" = "soldCount" + ${order.quantity}
          WHERE "id" = ${order.ticketCategoryId}
          AND ("totalStock" IS NULL OR "soldCount" + ${order.quantity} <= "totalStock")`;
          if (affected === 0) {
            // Stock repris entre-temps : paiement accepté non honorable → REVIEW.
            await tx.order.update({
              where: { id: order.id },
              data: { paymentStatus: 'REVIEW' },
            });
            outcome = 'REVIEW';
            continue;
          }
        } else if (order.paymentStatus !== 'PENDING') {
          // Statut inattendu (FAILED…) pour un paiement confirmé : à résoudre.
          await tx.order.update({
            where: { id: order.id },
            data: { paymentStatus: 'REVIEW' },
          });
          outcome = 'REVIEW';
          continue;
        }

        await this.settle(tx, order);
      }
    });
    return outcome;
  }

  // Honore UNE commande : billets + 2 écritures ledger + passage PAID.
  private async settle(
    tx: Prisma.TransactionClient,
    order: OrderWithEvent,
  ): Promise<void> {
    const event = order.ticketCategory.event;

    const tickets = Array.from({ length: order.quantity }, () => ({
      orderId: order.id,
      ticketCategoryId: order.ticketCategoryId,
      qrToken: randomUUID(),
      expiresAt: event.endDate,
    }));
    await tx.ticket.createMany({ data: tickets });

    // Ledger (USD = base comptable). Option A : la ligne PLATFORM porte le userId
    // de l'organisateur (account=PLATFORM la distingue ; le revenu plateforme =
    // SUM(account=PLATFORM), le solde organisateur = SUM(account=ORGANIZER)).
    await tx.ledgerEntry.createMany({
      data: [
        {
          account: 'ORGANIZER',
          userId: event.createdById,
          type: 'SALE_ORGANIZER',
          amount: order.organizerAmount,
          currency: 'USD',
          orderId: order.id,
          eventId: event.id,
        },
        {
          account: 'PLATFORM',
          userId: event.createdById,
          type: 'SALE_PLATFORM',
          amount: order.platformFee,
          currency: 'USD',
          orderId: order.id,
          eventId: event.id,
        },
      ],
    });

    await tx.order.update({
      where: { id: order.id },
      data: { paymentStatus: 'PAID' },
    });
  }

  // Paiement refusé : commandes PENDING → FAILED + stock relâché. Les commandes
  // EXPIRED ont déjà relâché leur stock (reaper) : simple passage FAILED.
  private async fail(orders: OrderWithEvent[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      for (const order of orders) {
        if (order.paymentStatus === 'PENDING') {
          await tx.$executeRaw`
          UPDATE "TicketCategory"
          SET "soldCount" = "soldCount" - ${order.quantity}
          WHERE "id" = ${order.ticketCategoryId}`;
          await tx.order.update({
            where: { id: order.id },
            data: { paymentStatus: 'FAILED' },
          });
        } else if (order.paymentStatus === 'EXPIRED') {
          await tx.order.update({
            where: { id: order.id },
            data: { paymentStatus: 'FAILED' },
          });
        }
      }
    });
  }

  private async log(paymentRef: string, rawBody: string): Promise<void> {
    try {
      await this.prisma.paymentProviderLog.create({
        data: {
          paymentRef,
          direction: 'WEBHOOK',
          requestBody: JSON.parse(rawBody) as object,
          status: 'RECEIVED',
        },
      });
    } catch (err) {
      this.logger.warn(
        `PaymentProviderLog (WEBHOOK) non écrit: ${String(err)}`,
      );
    }
  }
}
