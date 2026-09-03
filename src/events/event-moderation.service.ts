import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { notificationText } from 'src/notifications/notification-text';

interface ModerationPayload {
  sub: string;
  type: string;
  jti: string;
}

@Injectable()
export class EventModerationService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  // Token signé porté par les liens magiques du mail équipe (durée de vie 7 jours).
  generateModerationToken(eventId: string): string {
    return this.jwtService.sign(
      { sub: eventId, type: 'event-moderation', jti: randomUUID() },
      { expiresIn: '7d' },
    );
  }

  async moderate(
    token: string,
    decision: 'approve' | 'reject',
  ): Promise<{ message: string }> {
    let payload: ModerationPayload;
    try {
      payload = this.jwtService.verify<ModerationPayload>(token);
    } catch {
      throw new UnauthorizedException('Lien de modération invalide ou expiré.');
    }

    if (payload.type !== 'event-moderation') {
      throw new ForbiddenException('Type de token non autorisé.');
    }

    // Anti-rejeu : un lien de modération ne sert qu'une fois.
    const used = await this.prisma.usedToken.findUnique({
      where: { jti: payload.jti },
    });
    if (used) {
      throw new ConflictException('Cet événement a déjà été modéré.');
    }

    const event = await this.prisma.event.findUnique({
      where: { id: payload.sub },
      include: { createdBy: true },
    });
    if (!event) {
      throw new NotFoundException('Événement introuvable.');
    }
    if (event.status !== $Enums.EventStatus.PENDING_REVIEW) {
      throw new ConflictException('Cet événement a déjà été modéré.');
    }

    const approved = decision === 'approve';
    const newStatus = approved
      ? $Enums.EventStatus.PUBLISHED
      : $Enums.EventStatus.REJECTED;

    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id: event.id },
        data: { status: newStatus, reviewedAt: new Date() },
      });
      await tx.usedToken.create({ data: { jti: payload.jti } });

      const t = approved
        ? notificationText.eventPublished(event.title)
        : notificationText.eventRejected(event.title);
      await tx.notification.create({
        data: {
          userId: event.createdById,
          type: approved ? 'EVENT_PUBLISHED' : 'EVENT_REJECTED',
          title: t.title,
          body: t.body,
          eventId: event.id,
        },
      });
    });

    // Notifier le créateur s'il a une adresse email.
    if (event.createdBy?.email) {
      await this.mailService.sendEventDecisionEmail(
        event.createdBy.email,
        event.title,
        approved,
      );
    }

    return {
      message: approved
        ? "L'événement a été validé et publié."
        : "L'événement a été refusé.",
    };
  }
}
