// otp/otp.module.ts
import { Module } from '@nestjs/common';
import { OtpService } from './otp.service';

@Module({
  providers: [OtpService],
  exports: [OtpService], // permet de l'utiliser dans AuthModule
})
export class OtpModule {}
