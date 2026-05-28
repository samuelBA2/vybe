// otp/otp.module.ts
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';
import { SmsModule } from 'src/sms/sms.module'; 

@Module({
  providers: [OtpService],// injecte SmsService dans OtpService
  imports: [SmsModule], // pour pouvoir utiliser SmsService dans OtpService
  exports: [OtpService], // permet de l'utiliser dans AuthModule
})
export class OtpModule {}
