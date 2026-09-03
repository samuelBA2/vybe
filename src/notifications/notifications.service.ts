import { Injectable } from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationDto } from './dto/notification.dto';

// Plafond de sécurité (pas une pagination) : borne le volume chargé. Un utilisateur
// réel n'atteint jamais cette valeur en v1.
const MAX_NOTIFICATIONS = 100;

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  // Helper appelé par les déclencheurs (soumission/décision). Le texte est déjà rendu.
  async create(
    userId: string,
    type: $Enums.NotificationType,
    title: string,
    body: string,
    eventId?: string,
  ): Promise<void> {
    await this.prisma.notification.create({
      data: { userId, type, title, body, eventId },
    });
  }

  async listForUser(userId: string): Promise<NotificationDto[]> {
    const rows = await this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: MAX_NOTIFICATIONS,
      select: {
        id: true,
        type: true,
        title: true,
        body: true,
        eventId: true,
        read: true,
        createdAt: true,
      },
    });
    return rows;
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }

  // Ownership + idempotent : ne touche que la notif non lue de CE user. Aucune
  // distinction 403/404 (pas de fuite d'existence). No-op si déjà lue ou pas à soi.
  async markRead(userId: string, id: string): Promise<{ ok: true }> {
    await this.prisma.notification.updateMany({
      where: { id, userId, read: false },
      data: { read: true },
    });
    return { ok: true };
  }
}
