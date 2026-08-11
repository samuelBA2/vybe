import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';


const ORPHAN_TTL_MS = 6 * 60 * 60 * 1000; // 6 h non attaché → orphelin

@Injectable()
export class UploadsCleanupService {
    private readonly logger = new Logger(UploadsCleanupService.name);

    constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
    ) {}

    @Cron(CronExpression.EVERY_HOUR)
    async purgeOrphans() {
    const cutoff = new Date(Date.now() - ORPHAN_TTL_MS);
    const orphans = await this.prisma.uploadedAsset.findMany({
        where: { attached: false, createdAt: { lt: cutoff } },
    });
    if (!orphans.length) return;

    this.logger.log(`Purge de ${orphans.length} upload(s) orphelin(s).`);
    for (const o of orphans) {
        try {
        await this.cloudinary.deleteImage(o.publicId); // supprime le fichier distant
        await this.prisma.uploadedAsset.delete({ where: { id: o.id } }); // puis la ligne
        } catch (err) {
        // On logge et on continue : un échec isolé ne doit pas bloquer les autres,
        // et l'asset sera réessayé au prochain passage (rien de silencieux).
        this.logger.error(
            `Échec purge orphelin ${o.publicId}`,
            err instanceof Error ? err.stack : String(err),
        );
        }
    }
    }
}