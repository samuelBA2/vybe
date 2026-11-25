import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateReservationDto } from './dto/create-reservation.dto';

@Injectable()
export class ReservationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreateReservationDto) {
    const category = await this.prisma.ticketCategory.findUnique({
      where: { id: dto.categoryId },
      include: { event: true },
    });
    if (!category)
      throw new NotFoundException('Catégorie de billet introuvable.');
    if (!category.reservationEnabled) {
      throw new ForbiddenException(
        "Cette catégorie n'est pas ouverte à la réservation.",
      );
    }
    const event = category.event;
    if (event.status !== 'PUBLISHED')
      throw new ForbiddenException("Cet événement n'est pas ouvert.");
    if (event.purchaseDeadline < new Date())
      throw new ForbiddenException('Les réservations sont clôturées.');

    const qrToken = randomUUID();

    try {
      const reservation = await this.prisma.$transaction(async (tx) => {
        // 1. Plafond atomique : +1 seulement si réservable ET sous le plafond. 0 ligne = saturé.
        const affected = await tx.$executeRaw`
          UPDATE "TicketCategory"
          SET "reservedCount" = "reservedCount" + 1
          WHERE "id" = ${dto.categoryId}
            AND "reservationEnabled" = true
            AND "reservedCount" < "reservationCap"`;
        if (affected === 0) {
          throw new ConflictException(
            'Plus de réservations disponibles pour cet événement.',
          );
        }

        // 2. Ligne Reservation. L'index unique partiel garantit "1 active / compte / event"
        //    → violation = déjà réservé (P2002, capturé plus bas → rollback du +1).
        return tx.reservation.create({
          data: {
            eventId: event.id,
            categoryId: dto.categoryId,
            userId,
            qrToken,
            status: 'RESERVED',
            resolution: 'PENDING',
            holderFirstName: dto.holderFirstName,
            holderLastName: dto.holderLastName,
            holderPhone: dto.holderPhone,
            reservedAt: new Date(),
            expiresAt: event.endDate,
          },
        });
      });

      return {
        reservationId: reservation.id,
        reference: event.reference,
        qrToken: reservation.qrToken,
      };
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new ConflictException(
          'Vous avez déjà une réservation active pour cet événement.',
        );
      }
      throw err;
    }
  }

  // Lecture d'UX : le front grise le bouton "Réserver" si true. Le POST reste la source de vérité.
  async hasActiveReservation(
    userId: string,
    eventId: string,
  ): Promise<boolean> {
    const count = await this.prisma.reservation.count({
      where: { userId, eventId, status: 'RESERVED' },
    });
    return count > 0;
  }
}
