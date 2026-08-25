import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';
import { publicIdFromUrl } from 'src/common/cloudinary-public-id';

@Injectable()
export class TicketsCleanupService {
  private readonly logger = new Logger(TicketsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // Purge quotidienne des billets expirés : ligne + médias Cloudinary (PNG image, PDF raw).
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpired() {
    const now = new Date();
    const expired = await this.prisma.ticket.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true, ticketImageUrl: true, pdfUrl: true },
    });
    if (!expired.length) return;

    // méthode planifiée 
    this.logger.log(`Purge de ${expired.length} billet(s) expiré(s).`);
    for (const t of expired) {
      try {
        // PNG (resource_type image) : publicId sans extension.
        if (t.ticketImageUrl) {
          await this.cloudinary.deleteAsset(publicIdFromUrl(t.ticketImageUrl), 'image');
        }
        // PDF (resource_type raw) : publicId AVEC extension.
        if (t.pdfUrl) {
          await this.cloudinary.deleteAsset(publicIdFromUrl(t.pdfUrl, true), 'raw');
        }
        await this.prisma.ticket.delete({ where: { id: t.id } });
      } catch (err) {
        // Un échec isolé ne bloque pas les autres ; réessayé au prochain passage.
        this.logger.error(
          `Échec purge billet ${t.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }
}
