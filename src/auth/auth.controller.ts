import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response, Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import { Headers } from '@nestjs/common';
import { SendPhoneOtpDto } from './dto/send-phone-otp.dto';
import { LoginEmailDto } from './dto/login-mail.dto';
import { VerifyOtpDto } from 'src/auth/dto/verify-otp.dto';
import { VerifyEmailOtpDto } from './dto/verify-mail.dto';
import { LoginPhoneDto } from './dto/login-phone.dto';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { SendEmailOtpDto } from './dto/send-mail-otp.dto';

// Nom du cookie httpOnly qui transporte le refresh token.
// path restreint à /auth : le cookie n'est envoyé que sur les routes d'auth.
const REFRESH_COOKIE = 'vybe_refresh';
const REFRESH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 jours (aligné sur le JWT)

function setRefreshCookie(res: Response, refreshToken: string) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure: isProd, // en prod (HTTPS) uniquement ; SameSite=None exige secure
    sameSite: isProd ? 'none' : 'lax', // front et API sur des domaines différents en prod
    path: '/auth',
    maxAge: REFRESH_MAX_AGE_MS,
  });
}

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Envoi d'OTP (email/SMS) : limite serrée pour bloquer le bombing et les coûts SendGrid/Twilio.
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @Post('email/send')
  registerEmail(@Body() dto: SendEmailOtpDto) {
    return this.authService.sendEmailOtp(dto);
  }

  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @Post('phone/send')
  sendPhoneOtp(@Body() dto: SendPhoneOtpDto) {
    return this.authService.sendPhoneOtp(dto);
  }

  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @Post('login/email')
  loginEmail(@Body() dto: LoginEmailDto) {
    return this.authService.loginEmail(dto);
  }

  // Vérification d'OTP : limite le brute force du code à 6 chiffres (en plus du compteur en base).
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login/email/verify')
  async verifyLoginEmail(
    @Body() dto: VerifyEmailOtpDto,
    @Headers('authorization') auth: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = auth?.replace('Bearer ', '');
    const tokens = await this.authService.verifyLoginEmailOtp(dto, token);
    setRefreshCookie(res, tokens.refreshToken);
    return tokens;
  }

  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @Post('login/phone')
  loginPhone(@Body() dto: LoginPhoneDto) {
    return this.authService.loginPhone(dto);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('login/phone/verify')
  async verifyLoginPhone(
    @Body() dto: VerifyOtpDto,
    @Headers('authorization') auth: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const token = auth?.replace('Bearer ', '');
    const tokens = await this.authService.verifyLoginPhoneOtp(dto, token);
    setRefreshCookie(res, tokens.refreshToken);
    return tokens;
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('phone/verify')
  verifyOtp(@Body() dto: VerifyOtpDto, @Headers('authorization') auth: string) {
    const token = auth?.replace('Bearer ', '');
    return this.authService.verifyPhoneOtp(dto, token);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @Post('email/verify')
  verifyEmailOtp(
    @Body() dto: VerifyEmailOtpDto,
    @Headers('authorization') auth: string,
  ) {
    const token = auth?.replace('Bearer ', '');
    return this.authService.verifyEmailOtp(dto, token);
  }

  @Post('complete-profile')
  async completeProfile(
    @Req() req,
    @Body() dto: CompleteProfileDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.authService.completeProfile(req, dto);
    setRefreshCookie(res, tokens.refreshToken);
    return tokens;
  }

  // Renouvelle l'access token à partir du cookie httpOnly (rotation du refresh).
  // Le frontend appelle cet endpoint au chargement (hydratation de session)
  // et automatiquement sur 401.
  @Post('refresh')
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!refreshToken) {
      throw new UnauthorizedException('Aucune session.');
    }
    const tokens = await this.authService.refresh(refreshToken);
    setRefreshCookie(res, tokens.refreshToken);
    return { accessToken: tokens.accessToken };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return { message: 'Déconnecté.' };
  }
}
