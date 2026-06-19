import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { OtpModule } from 'src/otp/otp.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  controllers: [UsersController],
  providers: [UsersService],
  imports: [
    PrismaModule,
    AuthModule,
    OtpModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  exports: [UsersService],
})
export class UsersModule {}
