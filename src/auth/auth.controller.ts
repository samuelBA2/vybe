import { Controller, Get, Post, Body, Patch, Param, Delete, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import { Headers } from '@nestjs/common'
import { SendPhoneOtpDto } from './dto/send-phone-otp.dto';
import { LoginEmailDto } from './dto/login-mail.dto';
import { VerifyOtpDto } from 'src/auth/dto/verify-otp.dto';
import { VerifyEmailOtpDto } from './dto/verify-mail.dto';
import { LoginPhoneDto } from './dto/login-phone.dto';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import {SendEmailOtpDto } from './dto/send-mail-otp.dto'
import { UseGuards } from '@nestjs/common';


@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('email/send')
  registerEmail(@Body() dto: SendEmailOtpDto) {
    return this.authService.sendEmailOtp(dto);
  }

  @Post('phone/send')
  sendPhoneOtp(@Body() dto: SendPhoneOtpDto) {
    return this.authService.sendPhoneOtp(dto);
  }

  @Post('login/email')
  loginEmail(@Body() dto: LoginEmailDto) {
    return this.authService.loginEmail(dto);
  }

  @Post('login/phone')
  loginPhone(@Body() dto: LoginPhoneDto) {
    return this.authService.loginPhone(dto);
  }

  @Post('phone/verify')
  verifyOtp(@Body() dto: VerifyOtpDto, @Headers('authorization') auth: string, ) {
    const token = auth?.replace('Bearer ', '');
    return this.authService.verifyPhoneOtp(dto, token)
  }

  @Post('email/verify')
  verifyEmailOtp(@Body() dto: VerifyEmailOtpDto, @Headers('authorization') auth: string,) {
    const token = auth?.replace('Bearer ','');
    return this.authService.verifyEmailOtp(dto, token)
  }

  @Post('complete-profile')
  completeProfile(@Req() req, @Body() dto: CompleteProfileDto) {
    return this.authService.completeProfile(req, dto);
  }

  // @Post()
  // @UseGuards(JwtAuthGuard)
  // logout() {
  //   return this.authService.logout();
  // }

  @Get()
  findAll() {
    return this.authService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.authService.findOne(+id);
  }
}
