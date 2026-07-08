import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  Body,
  Req,
} from '@nestjs/common';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { $Enums } from '@prisma/client';
import { LoginEmailDto } from './dto/login-mail.dto';
import { VerifyOtpDto } from 'src/auth/dto/verify-otp.dto';
import { VerifyEmailOtpDto } from 'src/auth/dto/verify-mail.dto';
import { LoginPhoneDto } from './dto/login-phone.dto';
import { SmsService } from 'src/sms/sms.service';
import { OtpService } from 'src/otp/otp.service';
import { ConfigService } from '@nestjs/config';
import { SendPhoneOtpDto } from './dto/send-phone-otp.dto';
import { SendEmailOtpDto } from './dto/send-mail-otp.dto';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { randomUUID } from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private smsService: SmsService,
    private config: ConfigService,
    private readonly OtpService: OtpService,
  ) {}

  // Method to sign JWT tokens partagés (access + refresh)(l'utilisateur se connecte directement à l'inscription)
  private signToken(payload: { sub: string; role: string }) {
    const secret = this.config.get<string>('JWT_SECRET');

    if (!secret) {
      throw new Error('JWT secret not configured');
    }

    const accessToken = this.jwt.sign(
      { ...payload, type: 'access' },
      { secret, expiresIn: '30m' },
    );
    const refreshToken = this.jwt.sign(
      { ...payload, type: 'refresh' },
      { secret, expiresIn: '30d' },
    );

    return { accessToken, refreshToken };
  }

  //connexion par email : envoie un OTP si le compte existe
  async loginEmail(dto: LoginEmailDto) {

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });


    if (user && user.emailVerified && user.isValid) {
      try {
        await this.OtpService.sendLoginEmailOtp(dto.email);
      } catch {
        // On n'expose pas l'état interne (cooldown/blocage) : réponse uniforme.
      }
    }
    const tempToken = this.jwt.sign(
      { email: dto.email, purpose: 'login-verify', jti: randomUUID() },
      { secret: process.env.JWT_SECRET, expiresIn: '10m' },
    );
    return {
      message: 'Un code de vérification vous a été envoyé.',
      token: tempToken,
    };
  }

  //connexion par téléphone : envoie un OTP si le compte existe
  async loginPhone(dto: LoginPhoneDto) {
    const user = await this.prisma.user.findUnique({
      where: { phone: dto.phone },
    });

    if (user && user.phoneVerified && user.isValid) {
      try {
        await this.OtpService.sendLoginPhoneOtp(dto.phone);
      } catch {
        // On n'expose pas l'état interne (cooldown/blocage) : réponse uniforme.
      }
    }

    const tempToken = this.jwt.sign(
      { phone: dto.phone, purpose: 'login-verify', jti: randomUUID() },
      { secret: process.env.JWT_SECRET, expiresIn: '10m' },
    );
    return {
      message: 'Un code de vérification vous a été envoyé.',
      token: tempToken,
    };
  }

  //vérification du code OTP de connexion (email)
  async verifyLoginEmailOtp(dto: VerifyEmailOtpDto, token: string) {
    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET });
    } catch {
      throw new UnauthorizedException('Session expirée. Veuillez recommencer.');
    }

    if (payload.purpose !== 'login-verify' || !payload.email) {
      throw new UnauthorizedException('Token invalide');
    }

    await this.OtpService.verifyOtp(payload.email, dto.otp);

    const user = await this.prisma.user.findUnique({
      where: { email: payload.email },
    });
    if (!user || !user.isValid)
      throw new UnauthorizedException('Identifiants invalides');
    
    return this.signToken({ sub: user.id, role: user.role });
  }

  //vérification du code OTP de connexion (téléphone)
  async verifyLoginPhoneOtp(dto: VerifyOtpDto, token: string) {
    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET });
    } catch {
      throw new UnauthorizedException('Session expirée. Veuillez recommencer.');
    }

    if (payload.purpose !== 'login-verify' || !payload.phone) {
      throw new UnauthorizedException('Token invalide');
    }

    await this.OtpService.verifyOtp(payload.phone, dto.otp);

    const user = await this.prisma.user.findUnique({
      where: { phone: payload.phone },
    });
    if (!user || !user.isValid)
      throw new UnauthorizedException('Identifiants invalides');

    return this.signToken({ sub: user.id, role: user.role });
  }

  //Inscription par téléphone : envoie et vérification du code OTP premiere étape de la création du compte
  async sendPhoneOtp(dto: SendPhoneOtpDto) {
    await this.OtpService.sendPhoneOtp(dto.phone);

    //token temporaire qui transporte le numero jusqu'à la vérification
    const tempToken = this.jwt.sign(
      { phone: dto.phone, purpose: 'verify', Jti: randomUUID() },
      { secret: process.env.JWT_SECRET, expiresIn: '15min' },
    );
    return {
      message: 'Un code de verification vous a été envoyé',
      token: tempToken,
    };
  }

  //Inscription par téléphone : envoie et vérification du code OTP premiere étape de la création du compte
  async sendEmailOtp(dto: SendEmailOtpDto) {
    await this.OtpService.sendEmailOtp(dto.email);

    const tempToken = this.jwt.sign(
      { email: dto.email, purpose: 'verify', jti: randomUUID() },
      { secret: process.env.JWT_SECRET, expiresIn: '15min' },
    );
    return {
      message: 'Un code de verification vous a été envoyé par email',
      token: tempToken,
    };
  }

  //verification du code OTP envoyé par téléphone,
  // et génération d'un token temporaire pour la suite de l'inscription (endpoint "complete-profile" pour compléter le profil et créer le compte)
  async verifyPhoneOtp(dto: VerifyOtpDto, token: string) {
    // Décoder le tempToken pour récupérer le phone
    const payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET });

    if (payload.purpose !== 'verify') {
      throw new UnauthorizedException('Token invalide');
    }

    const phone = payload.phone;
    await this.OtpService.verifyOtp(phone, dto.otp);

    const tempToken = this.jwt.sign(
      { phone, verified: true, purpose: 'complete-profile', jti: randomUUID() },
      { secret: process.env.JWT_SECRET, expiresIn: '15m' },
    );

    return {
      success: true,
      message: 'Code vérifié avec succès.',
      token: tempToken,
    };
  }

  async verifyEmailOtp(dto: VerifyEmailOtpDto, token: string) {
    let payload: any;

    try {
      payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET });
    } catch (error) {
      throw new UnauthorizedException(
        'Session expirée. Veuillez recommencer .',
      );
    }
    if (payload.purpose !== 'verify') {
      throw new UnauthorizedException('Token invalide');
    }

    const email = payload.email;
    await this.OtpService.verifyOtp(email, dto.otp);

    // Recherche du code OTP dans la base de données
    const tempToken = this.jwt.sign(
      { email, verified: true, purpose: 'complete-profile', jti: randomUUID() },
      { secret: process.env.JWT_SECRET, expiresIn: '15m' },
    );
    return {
      success: true,
      message: 'Code verifié avec succès.',
      token: tempToken,
    };
  }

  async completeProfile(@Req() req, @Body() dto: CompleteProfileDto) {
    //Extraire et vérifier le token temporaire du header Authorization
    let payload: any;
    try {
      const token = req.headers.authorization?.split(' ')[1];
      payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET });
    } catch {
      throw new BadRequestException(
        'Ce lien a expiré, recommence le processus de connexion',
      );
    }

    //Verifier que le purpose et le flag "verified" sont corrects, et que le token n'a pas déjà été utilisé (jti stocké en base)
    if (payload.purpose !== 'complete-profile' || !payload.verified) {
      throw new BadRequestException(
        'Une erreur est survenue, recommence le processus de connexion',
      );
    }

    //Vérifier que le Jti du token n'a pas été déjà consommé (pour éviter réutilisation du même token)
    const alreadyExists = await this.prisma.usedToken.findUnique({
      where: { jti: payload.jti },
    });
    if (alreadyExists) {
      throw new BadRequestException(
        'Ce lien a expiré, recommence le processus de connexion',
      );
    }

    //Verifier si le user n'existe pas déjà
    const identifier = payload.phone
      ? { phone: payload.phone }
      : { email: payload.email };

    const existing = await this.prisma.user.findUnique({ where: identifier });

    if (existing) {
      throw new BadRequestException(
        'Une erreur est survenue, recommence le processus de connexion',
      );
    }

    //Créer le compte utilisateur et invalidation du token temporaire (en stockant son jti en base)
    const hash = await bcrypt.hash(dto.password, 10);
    const data: any = {
      firstname: dto.firstName,
      lastname: dto.lastName,
      hashedPassword: hash,
      role: $Enums.Role.USER,
    };

    if (payload.phone) {
      data.phone = payload.phone;
      data.phoneVerified = true;
    } else if (payload.email) {
      data.email = payload.email;
      data.emailVerified = true;
    }

    const [user] = await this.prisma.$transaction([
      this.prisma.user.create({ data }),
      this.prisma.usedToken.create({ data: { jti: payload.jti } }),
    ]);

    return this.signToken({ sub: user.id, role: user.role });
  }
  // Renouvellement de session : vérifie le refresh token (cookie httpOnly)
  // et ré-émet une paire access/refresh si l'utilisateur est toujours valide.
  async refresh(refreshToken: string) {
    let payload: any;
    try {
      payload = this.jwt.verify(refreshToken, {secret: process.env.JWT_SECRET,});
    } catch {
      throw new UnauthorizedException('Session expirée. Reconnectez-vous.');
    }

    if (payload.type !== 'refresh' || !payload.sub) {
      throw new UnauthorizedException('Token invalide.');
    }  
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user || !user.isValid) {
      throw new UnauthorizedException('Session expirée. Reconnectez-vous.');
    }

    return this.signToken({ sub: user.id, role: user.role });
  }

  findAll() {
    return `This action returns all auth`;
  }

  findOne(id: number) {
    return `This action returns a #${id} auth`;
  }
}
