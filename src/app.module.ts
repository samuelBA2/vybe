import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { PrismaModule } from './prisma/prisma.module';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { OtpModule } from './otp/otp.module';



@Module({
  imports: [ConfigModule.forRoot({isGlobal: true}),
    AuthModule, UsersModule, PrismaModule, JwtModule.register({
    secret: process.env.JWT_SECRET,
    signOptions: { expiresIn: '1h' },
  }),
  UsersModule,
  OtpModule,

  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
