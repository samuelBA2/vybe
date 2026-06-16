import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { SmsService } from './sms.service';

@Controller('sms')
export class SmsController {
  constructor(private readonly smsService: SmsService) {}

  @Post('send')
  send(@Body() body: {to: string; code: string}) {
    return this.smsService.sendOtp(body.to, body.code);
  }
}