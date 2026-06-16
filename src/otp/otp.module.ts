// otp/otp.module.ts
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { SmsModule } from 'src/sms/sms.module'; 
import { MailModule } from 'src/mail/mail.module';
import { PrismaModule } from 'src/prisma/prisma.module';

@Module({
  providers: [ OtpService],// injecte SmsService dans OtpService
  imports: [PrismaModule, MailModule, SmsModule], // pour pouvoir utiliser SmsService dans OtpService
  exports: [OtpService], // permet de l'utiliser dans AuthModule
})
export class OtpModule {}
