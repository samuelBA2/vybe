import { $Enums } from '@prisma/client';

// Forme exposée au client (jamais userId). type → icône/dégradé côté frontend.
export interface NotificationDto {
  id: string;
  type: $Enums.NotificationType;
  title: string;
  body: string;
  eventId: string | null;
  read: boolean;
  createdAt: Date;
}
