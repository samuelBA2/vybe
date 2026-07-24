import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OtpModule } from './otp/otp.module';
import { SmsModule } from './sms/sms.module';
import { MailModule } from './mail/mail.module';
import { EventsModule } from './events/events.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting global : 20 requêtes/minute par IP (défaut).
    // Les routes sensibles (envoi OTP, login) ont des limites plus serrées via @Throttle.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    AuthModule,
    PrismaModule,
    JwtModule.registerAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (configService: ConfigService) => ({
    secret: configService.get<string>('JWT_SECRET'),
    signOptions: { expiresIn: '1h' },
  }),
}),
    UsersModule,
    OtpModule,
    SmsModule,
    MailModule,
    EventsModule,
    CloudinaryModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // Applique le rate limiting à toutes les routes de l'application.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
