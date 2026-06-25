import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/guards/roles.guard';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventModerationService } from './event-moderation.service';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    AuthModule, // fournit JwtAuthGuard (réexporté)
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  controllers: [EventsController],
  providers: [EventsService, EventModerationService, RolesGuard],
})
export class EventsModule {}
