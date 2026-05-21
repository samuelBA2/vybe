import { Controller, Get, Post, Body, Patch, Param, Delete } from '@nestjs/common';
import { AuthService } from './auth.service';
import { UpdateAuthDto } from './dto/update-auth.dto';
import { RegisterEmailDto } from './dto/register-mail.dto';
import { RegisterPhoneDto } from './dto/register-phone.dto';
import { LoginEmailDto } from './dto/login-mail.dto';
import { VerifyOtpDto } from 'src/auth/dto/verify-otp.dto';
import { LoginPhoneDto } from './dto/login-phone.dto';

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

  @Post('register/phone')
  registerPhone(@Body() dto: RegisterPhoneDto) {
    return this.authService.registerPhone(dto);
  }

  @Post('login/phone')
  loginPhone(@Body() dto: LoginPhoneDto) {
    return this.authService.loginPhone(dto);
  }

  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Post('phone/send')
  sendPhoneOtp(@Body() dto: RegisterPhoneDto) {
    return this.authService.sendPhoneOtp(dto);
  }

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
