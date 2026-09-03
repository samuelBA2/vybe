import { Controller, Get, Patch, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@UseGuards(JwtAuthGuard)
@Controller('me')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  // Liste des notifications de l'utilisateur connecté (plus récentes d'abord).
  @Get('notifications')
  async list(@Req() req) {
    return this.notifications.listForUser(req.user.sub);
  }

  // Compteur des non-lues (badge chiffré de la cloche).
  @Get('notifications/unread-count')
  async unreadCount(@Req() req) {
    return this.notifications.unreadCount(req.user.sub);
  }

  // Marque une notification comme lue (propriétaire uniquement, idempotent).
  @Patch('notifications/:id/read')
  async markRead(@Req() req, @Param('id') id: string) {
    return this.notifications.markRead(req.user.sub, id);
  }
}
