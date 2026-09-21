import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { PAYOUT_STUCK_TTL_MINUTES } from 'src/common/constants';
import { PayoutsService } from './payouts.service';

// Reaper payout : un Payout PENDING au-delà du TTL est re-vérifié (checkPayoutStatus
// via resolvePayout) ; s'il traîne toujours → REVIEW (un mouvement sortant ne reste
// jamais non résolu). Pas de relâche de stock (≠ reaper dépôts). Le webhook reste
// le chemin normal.
@Injectable()
export class PayoutsCleanupService {
  private readonly logger = new Logger(PayoutsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly payouts: PayoutsService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reapStuckPayouts(): Promise<void> {
    const cutoff = new Date(Date.now() - PAYOUT_STUCK_TTL_MINUTES * 60_000);
    const stuck = await this.prisma.payout.findMany({
      where: { status: 'PENDING', createdAt: { lt: cutoff } },
      select: { payoutRef: true },
    });
    for (const { payoutRef } of stuck) {
      try {
        const res = await this.payouts.resolvePayout(payoutRef, {
          markStuck: true,
        });
        this.logger.log(`Reaper payout : ${payoutRef} → ${res.status}`);
      } catch (err) {
        this.logger.warn(
          `Reaper payout : échec sur ${payoutRef}: ${String(err)}`,
        );
      }
    }
  }
}
