import { Injectable } from '@nestjs/common';
import { CreateSmDto } from './dto/create-sm.dto';
import { UpdateSmDto } from './dto/update-sm.dto';
import { ConfigService } from '@nestjs/config';
import { Twilio } from 'twilio';

@Injectable()
export class SmsService {
  private client: Twilio;

  constructor(private config: ConfigService) {
    this.client = new Twilio(
      this.config.get<string>('TWILIO_ACCOUNT_SID'),
      this.config.get<string>('TWILIO_AUTH_TOKEN'),
    );
  }

  async sendOtp(to: string, code: string) {
    return this.client.messages.create({
      body:`Your verification code is: ${code}`,
      from: this.config.get<string>('TWILIO_PHONE_NUMBER'),
      to,
    });
  }
}

