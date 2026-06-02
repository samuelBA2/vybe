import { Controller, Get, Post, Body, Patch, Param, Delete, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UpdateAuthDto } from './dto/update-auth.dto';
import { RegisterEmailDto } from './dto/register-mail.dto';
import { SendPhoneOtpDto } from './dto/send-phone-otp.dto';
import { LoginEmailDto } from './dto/login-mail.dto';
import { VerifyOtpDto } from 'src/auth/dto/verify-otp.dto';
import { LoginPhoneDto } from './dto/login-phone.dto';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { UseGuards } from '@nestjs/common';


@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register/email')
  registerEmail(@Body() dto: RegisterEmailDto) {
    return this.authService.registerEmail(dto);
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
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Post('phone/send')
  sendPhoneOtp(@Body() dto: SendPhoneOtpDto) {
    return this.authService.sendPhoneOtp(dto);
  }

  @Post('email/send')
  sendEmailOtp(@Body() dto: RegisterEmailDto) {
    return this.authService.sendEmailOtp(dto);
  }

  // @Post('email/verify')
  // verifyEmailOtp(@Body() dto: VerifyOtpDto) {
  //   return this.authService.verifyEmailOtp(dto);
  // }

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

  @Patch(':id')
  update(@Param('id') id: string, @Body() updateAuthDto: UpdateAuthDto) {
    return this.authService.update(+id, updateAuthDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.authService.remove(+id);
  }
}
