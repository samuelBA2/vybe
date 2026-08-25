import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AccountsCleanupService } from './users.cleanup';
import { CloudinaryModule } from 'src/cloudinary/cloudinary.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { OtpModule } from 'src/otp/otp.module';
import { JwtModule } from '@nestjs/jwt';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AccountsCleanupService],
  imports: [
    PrismaModule,
    AuthModule,
    OtpModule,
    CloudinaryModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  exports: [UsersService],
})
export class UsersModule {}
