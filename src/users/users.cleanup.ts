import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "src/prisma/prisma.service";
import { CloudinaryService } from "src/cloudinary/cloudinary.service";

const GRACE_PERIOD = 14 * 24 * 60 * 60 * 1000; // 14 jours en millisecondes

@Injectable()
export class AccountsCleanupService {
    private readonly logger = new Logger(AccountsCleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly cloudinary: CloudinaryService,
    ) {}

    // Anonymisation quotidienne (RGPD) des comptes soft-deleted à J+14.
    // La ligne et ses relations (orders, events...) sont conservées ; seules les
    // données personnelles sont effacées. deletionRequestedAt=null marque la
    // finalisation → le compte est exclu des passages suivants.
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async purgeSoftDeleted() {
        const cutoff = new Date(Date.now() - GRACE_PERIOD);
        const accounts = await this.prisma.user.findMany({
            where: { isValid: false, deletionRequestedAt: { lt: cutoff } },
            select: { id: true, avatarPublicId: true },
        });
        if (!accounts.length) return;

        this.logger.log(`Anonymisation de ${accounts.length} compte(s) soft-deleted.`);
        for (const u of accounts) {
            try {
                if (u.avatarPublicId) {
                    await this.cloudinary.deleteAsset(u.avatarPublicId, 'image');
                }
                await this.prisma.user.update({
                    where: { id: u.id },
                    data: {
                        email: null, // @unique → libéré pour une future ré-inscription
                        phone: null, // @unique → idem
                        hashedPassword: null,
                        firstname: null,
                        lastname: null,
                        avatarUrl: null,
                        avatarPublicId: null,
                        deletionRequestedAt: null, // marqueur : compte finalisé
                    },
                });
            } catch (err) {
                // Un échec isolé ne bloque pas les autres ; réessayé au prochain passage.
                this.logger.error(
                    `Échec anonymisation compte ${u.id}`,
                    err instanceof Error ? err.stack : String(err),
                );
            }
        }
    }
}
