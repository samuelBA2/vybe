import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import {JwtStrategy} from 'src/jwt.strategy';
import { PassportModule } from '@nestjs/passport';

@Module({
  imports : [
    PrismaModule, 
    PassportModule,
    JwtModule.register({
    secret: process.env.JWT_SECRET,
    signOptions: { expiresIn: '7d' },
  }),
],
  controllers: [AuthController],
  providers: [AuthService],
  exports:[JwtModule],
})
export class AuthModule {}
