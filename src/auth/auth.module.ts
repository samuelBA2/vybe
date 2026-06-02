import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy} from 'src/jwt.strategy';
import { PassportModule } from '@nestjs/passport';
import { SmsModule } from 'src/sms/sms.module';
import { ConfigModule, ConfigService } from '@nestjs/config';


@Module({
  imports : [
    PrismaModule, 
    PassportModule,
    SmsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
    secret: config.get<string>('JWT_SECRET'),
    signOptions: { expiresIn: '1h' },
  }),
    }),
  ],  
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports:[JwtModule],
})
export class AuthModule {}
