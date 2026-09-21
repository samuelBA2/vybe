import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { PAYMENT_PENDING_TTL_MINUTES } from 'src/common/constants';
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
    const cutoff = new Date(Date.now() - PAYMENT_PENDING_TTL_MINUTES * 60_000);

    // Un paymentRef par checkout : on dédoublonne pour ne résoudre chaque checkout
    // qu'une fois (resolvePayment traite toutes ses commandes ensemble).
    const stale = await this.prisma.order.findMany({
      where: {
        paymentStatus: 'PENDING',
        createdAt: { lt: cutoff },
        paymentRef: { not: null },
      },
      select: { paymentRef: true },
      distinct: ['paymentRef'],
    });

    for (const { paymentRef } of stale) {
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
      }
    }
  }
}
