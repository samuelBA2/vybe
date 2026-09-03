import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';

@Module({
  imports: [PrismaModule, AuthModule], // AuthModule fournit JwtAuthGuard
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService], // consommé par EventsModule (déclencheurs)
})
export class NotificationsModule {}
