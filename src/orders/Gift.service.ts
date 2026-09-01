import {
  Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { MAX_GIFTS_PER_CATEGORY } from 'src/common/constants';
import { CreateGiftDto } from './dto/CreateGift.dto';

@Injectable()
export class GiftService {
  constructor(private readonly prisma: PrismaService) {}

  // Émission de billets OFFERTS par le créateur pour son propre événement.
  // Gratuits (montants 0), plafonnés à MAX_GIFTS_PER_CATEGORY par catégorie,
  // consomment le stock (soldCount) et sont exclus du calcul financier (paymentStatus GIFT ≠ PAID).
  async emitGifts(userId: string, reference: string, dto: CreateGiftDto) {
    const event = await this.prisma.event.findUnique({ where: { reference } });
    if (!event) throw new NotFoundException('Événement introuvable.');
    if (event.createdById !== userId) {
      throw new ForbiddenException('Vous ne gérez pas cet événement.');
    }
    // Offrir des billets suit les mêmes gardes que la vente : l'événement doit
    // être publié et la date limite non dépassée (ferme aussi l'appel direct à
    // l'endpoint sur un événement non validé, rejeté ou terminé).
    if (event.status !== 'PUBLISHED') {
      throw new ForbiddenException("Cet événement n'est pas ouvert : l'offre de billets nécessite un événement publié.");
    }
    if (event.purchaseDeadline < new Date()) {
      throw new ForbiddenException('Les émissions pour cet événement sont clôturées (date limite dépassée).');
    }
    // Éligibilité : illimité (totalCapacity null) toujours OK ; limité seulement si > 50.
    if (event.totalCapacity !== null && event.totalCapacity <= 50) {
      throw new ForbiddenException(
        "L'offre de billets nécessite un forfait illimité ou un forfait limité de plus de 50 billets.",
      );
    }
    const category = await this.prisma.ticketCategory.findFirst({
      where: { id: dto.ticketCategoryId, eventId: event.id },
    });
    if (!category) throw new NotFoundException('Catégorie de billet introuvable.');
    // Pré-check plafond (message clair) ; l'UPDATE gardé ci-dessous reste l'autorité anti-course.
    if (category.giftedCount + dto.quantity > MAX_GIFTS_PER_CATEGORY) {
      throw new BadRequestException(
        `Vous ne pouvez offrir que ${MAX_GIFTS_PER_CATEGORY} billets pour « ${category.name} » (déjà ${category.giftedCount} offert(s)).`,
      );
    }

    const orderId = await this.prisma.$transaction(async (tx) => {
      // Réservation atomique : plafond des 10 ET anti-survente en un seul UPDATE gardé.
      const affected = await tx.$executeRaw`
        UPDATE "TicketCategory"
        SET "soldCount" = "soldCount" + ${dto.quantity},
            "giftedCount" = "giftedCount" + ${dto.quantity}
        WHERE "id" = ${dto.ticketCategoryId}
        AND "giftedCount" + ${dto.quantity} <= ${MAX_GIFTS_PER_CATEGORY}
        AND ("totalStock" IS NULL OR "soldCount" + ${dto.quantity} <= "totalStock")`;
      if (affected === 0) {
        throw new ConflictException(`Émission impossible : plafond ou stock atteint (${category.name}).`);
      }
      const order = await tx.order.create({
        data: {
          userId,
          ticketCategoryId: dto.ticketCategoryId,
          quantity: dto.quantity,
          unitPrice: 0, totalAmount: 0, platformFee: 0, organizerAmount: 0,
          paymentStatus: 'GIFT',
        },
      });
      const tickets = Array.from({ length: dto.quantity }, () => ({
        orderId: order.id,
        ticketCategoryId: dto.ticketCategoryId,
        qrToken: randomUUID(),
        expiresAt: event.endDate,
      }));
      await tx.ticket.createMany({ data: tickets });
      return order.id;
    });

    const tickets = await this.prisma.ticket.findMany({
      where: { orderId },
      select: { id: true },
    });
    return { orderId, tickets };
  }
}
