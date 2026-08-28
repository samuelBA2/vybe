import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class TicketsCleanupService {
  private readonly logger = new Logger(TicketsCleanupService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Purge quotidienne des billets expirés : les visuels (PNG/PDF) sont générés à la volée
  // (plus stockés sur Cloudinary), donc il n'y a plus qu'une ligne à supprimer.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpired() {
    const now = new Date();
    const { count } = await this.prisma.ticket.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    if (count) this.logger.log(`Purge de ${count} billet(s) expiré(s).`);
  }
}
