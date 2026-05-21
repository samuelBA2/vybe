import { Injectable, BadRequestException } from '@nestjs/common';

@Injectable()
export class OtpService {
    private otpStore = new Map<string, string>();

    async generateOtp(identifier: string): Promise<string> {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    this.otpStore.set(identifier, code);

    console.log(`OTP envoyé à ${identifier}: ${code}`);
    return code;
    }

    async verifyOtp(identifier: string, code: string): Promise<boolean> {
    const storedCode = this.otpStore.get(identifier);
    if (!storedCode || storedCode !== code) {
        throw new BadRequestException('OTP invalide ou expiré');
    }
    this.otpStore.delete(identifier);
    return true;
    }
}
