import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CHECKOUT_REQUEST_RETENTION_HOURS,
  PAYMENT_PENDING_TTL_MINUTES,
  PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS,
} from 'src/common/constants';
import { PaymentsService } from './payments.service';

// Reaper d'expiration : filet de sécurité si l'acheteur abandonne ou si le callback
// n'arrive jamais. Une commande PENDING au-delà du TTL est re-vérifiée côté serveur
// (checkStatus, via resolvePayment) : payée tardivement → PAID + billets + ledger ;
// sinon → EXPIRED + stock relâché (EXPIRED ≠ FAILED : un paiement encore plus tardif
// pourra re-honorer via le webhook). Le webhook reste le chemin normal.
@Injectable()
export class PaymentsCleanupService {
  private readonly logger = new Logger(PaymentsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reapExpiredPayments(): Promise<void> {
    // I1 : purge des clés d'idempotence périmées (un rejeu au-delà n'a plus de sens).
    try {
      await this.prisma.checkoutRequest.deleteMany({
        where: {
          createdAt: {
            lt: new Date(Date.now() - CHECKOUT_REQUEST_RETENTION_HOURS * 3_600_000),
          },
        },
      });
    } catch (err) {
      this.logger.warn(`Purge CheckoutRequest impossible : ${String(err)}`);
    }

    const cutoff = new Date(Date.now() - PAYMENT_PENDING_TTL_MINUTES * 60_000);

    // Un paymentRef par checkout : on dédoublonne pour ne résoudre chaque checkout
    // qu'une fois (resolvePayment traite toutes ses commandes ensemble).
    const stale = await this.prisma.order.findMany({
      where: {
        paymentStatus: 'PENDING',
        createdAt: { lt: cutoff },
        paymentRef: { not: null },
      },
      select: { paymentRef: true, createdAt: true },
      distinct: ['paymentRef'],
    });

    const hardLimit = new Date(
      Date.now() - PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS * 3_600_000,
    );
    for (const { paymentRef, createdAt } of stale) {
      if (!paymentRef) continue;
      try {
        const res = await this.payments.resolvePayment(paymentRef, {
          expireStale: true,
        });
        this.logger.log(`Reaper paiement : ${paymentRef} → ${res.status}`);
      } catch (err) {
        // Un échec sur un checkout ne doit pas interrompre le balayage des autres.
        this.logger.warn(
          `Reaper paiement : échec sur ${paymentRef}: ${String(err)}`,
        );
        // V1 : statut introuvable depuis trop longtemps → on libère le stock.
        if (createdAt < hardLimit) {
          try {
            await this.payments.expireUnresolved(paymentRef);
            this.logger.error(
              `Reaper paiement : ${paymentRef} expiré après ${PAYMENT_UNRESOLVED_HARD_LIMIT_HOURS} h sans statut fournisseur.`,
            );
          } catch (expireErr) {
            this.logger.warn(
              `Reaper paiement : expiration forcée impossible pour ${paymentRef}: ${String(expireErr)}`,
            );
          }
        }
      }
    }
  }
}
