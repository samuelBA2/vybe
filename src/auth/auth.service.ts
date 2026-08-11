import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Body,
  Req,
} from '@nestjs/common';
// import { UpdateAuthDto } from './dto/update-auth.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { $Enums, Prisma } from '@prisma/client';
import { VerifyOtpDto } from 'src/auth/dto/verify-otp.dto';
import { VerifyEmailOtpDto } from 'src/auth/dto/verify-mail.dto';
import { SmsService } from 'src/sms/sms.service';
import { OtpService } from 'src/otp/otp.service';
import { ConfigService } from '@nestjs/config';
import { SendPhoneOtpDto } from './dto/send-phone-otp.dto';
import { SendEmailOtpDto } from './dto/send-mail-otp.dto';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { randomUUID } from 'crypto';
import {
  BCRYPT_ROUNDS,
  MAX_LOGIN_ATTEMPTS,
  LOGIN_LOCK_DURATIONS_MS,
} from 'src/common/constants';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

// Hash factice comparé quand le compte n'existe pas / n'a pas de mot de passe :
// aligne le temps de réponse sur celui d'un vrai bcrypt.compare et évite de
// révéler l'inexistence d'un compte par le timing.
const DUMMY_HASH = bcrypt.hashSync('vybe-dummy-timing-guard', BCRYPT_ROUNDS);

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

  // Détermine si l'identifiant est un email (présence d'un @) ou un téléphone,
  // et fournit la clause Prisma + le canal d'envoi OTP correspondant.
  private resolveIdentifier(identifier: string): {
    where: { email: string } | { phone: string };
    channel: 'email' | 'phone';
  } {
    if (identifier.includes('@')) {
      return { where: { email: identifier }, channel: 'email' };
    }
    return { where: { phone: identifier }, channel: 'phone' };
  }

  // Verrou actif ? Lève un 403 avec le timestamp de fin (pour le compte à rebours front).
  private assertNotLocked(user: {
    loginLockedUntil: Date | null;
  }): void {
    if (user.loginLockedUntil && user.loginLockedUntil.getTime() > Date.now()) {
      const remainingMin = Math.ceil(
        (user.loginLockedUntil.getTime() - Date.now()) / 60000,
      );
      throw new ForbiddenException({
        message: `Trop de tentatives. Compte bloqué, réessayez dans ${remainingMin} minute(s).`,
        lockedUntil: user.loginLockedUntil.toISOString(),
      });
    }
  }

  // ─── Connexion par mot de passe (verrou progressif 5min → 1h → 12h) ───────────
  async login(dto: LoginDto) {
    const { where } = this.resolveIdentifier(dto.identifier);
    const user = await this.prisma.user.findUnique({ where });

    // Compte absent / invalide / sans mot de passe : réponse générique + hash
    // factice pour ne pas révéler l'inexistence (ni par le message, ni par le temps).
    if (!user || !user.isValid || !user.hashedPassword) {
      await bcrypt.compare(dto.password, DUMMY_HASH);
      throw new UnauthorizedException('Identifiants invalides');
    }

    // Verrou actif : on ne compare même pas le mot de passe.
    this.assertNotLocked(user);

    const matches = await bcrypt.compare(dto.password, user.hashedPassword);

    if (!matches) {
      const newAttempts = user.failedLoginAttempts + 1;

      // Franchissement d'un palier : on pose le verrou et on incrémente le niveau.
      if (newAttempts >= MAX_LOGIN_ATTEMPTS) {
        const durationIndex = Math.min(
          user.loginLockLevel,
          LOGIN_LOCK_DURATIONS_MS.length - 1,
        );
        const lockedUntil = new Date(
          Date.now() + LOGIN_LOCK_DURATIONS_MS[durationIndex],
        );
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: 0,
            loginLockLevel: user.loginLockLevel + 1,
            loginLockedUntil: lockedUntil,
          },
        });
        const remainingMin = Math.ceil(
          (lockedUntil.getTime() - Date.now()) / 60000,
        );
        throw new ForbiddenException({
          message: `Trop de tentatives. Compte bloqué, réessayez dans ${remainingMin} minute(s).`,
          lockedUntil: lockedUntil.toISOString(),
        });
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: newAttempts },
      });
      throw new UnauthorizedException(
        `Mot de passe incorrect. Il te reste ${MAX_LOGIN_ATTEMPTS - newAttempts} essai(s).`,
      );
    }

    // Succès : remise à zéro complète (compteur + palier + verrou).
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginAttempts: 0,
        loginLockLevel: 0,
        loginLockedUntil: null,
      },
    });
    return this.signToken({ sub: user.id, role: user.role });
  }

  // ─── Mot de passe oublié : envoi de l'OTP ─────────────────────────────────────
  async forgotPassword(dto: ForgotPasswordDto) {
    const { where, channel } = this.resolveIdentifier(dto.identifier);
    const user = await this.prisma.user.findUnique({ where });

    // Sous verrou actif : le reset ne doit pas offrir de contournement.
    if (user) {
      this.assertNotLocked(user);
    }

    if (user && user.isValid) {
      try {
        if (channel === 'email') {
          await this.OtpService.sendLoginEmailOtp(dto.identifier);
        } else {
          await this.OtpService.sendLoginPhoneOtp(dto.identifier);
        }
      } catch {
        // On n'expose pas l'état interne (cooldown/blocage) : réponse uniforme.
      }
    }

    // Réponse identique que le compte existe ou non (anti-énumération).
    const token = this.jwt.sign(
      {
        identifier: dto.identifier,
        purpose: 'password-reset',
        jti: randomUUID(),
      },
      { secret: process.env.JWT_SECRET, expiresIn: '10m' },
    );
    return {
      message: 'Si un compte existe, un code de vérification a été envoyé.',
      token,
    };
  }

  // ─── Mot de passe oublié : vérification OTP + changement de mot de passe ───────
  async resetPassword(dto: ResetPasswordDto, token: string) {
    let payload: any;
    try {
      payload = this.jwt.verify(token, { secret: process.env.JWT_SECRET });
    } catch {
      throw new BadRequestException(
        'Ce lien a expiré, recommence la réinitialisation.',
      );
    }

    if (payload.purpose !== 'password-reset' || !payload.identifier) {
      throw new BadRequestException('Token invalide.');
    }

    // Anti-rejeu : un même token ne peut réinitialiser qu'une fois.
    const alreadyUsed = await this.prisma.usedToken.findUnique({
      where: { jti: payload.jti },
    });
    if (alreadyUsed) {
      throw new BadRequestException(
        'Ce lien a expiré, recommence la réinitialisation.',
      );
    }

    const { where } = this.resolveIdentifier(payload.identifier);
    const user = await this.prisma.user.findUnique({ where });
    if (!user || !user.isValid) {
      throw new BadRequestException('Compte introuvable.');
    }

    // Garde-fou : pas de reset sous verrou actif.
    this.assertNotLocked(user);

    // Vérifie l'OTP (gère ses propres tentatives + blocage du code).
    await this.OtpService.verifyOtp(payload.identifier, dto.otp);

    if (dto.newPassword !== dto.confirmPassword) {
      throw new BadRequestException('Les mots de passe ne correspondent pas.');
    }

    // Refuse de réutiliser le mot de passe actuel.
    if (user.hashedPassword) {
      const same = await bcrypt.compare(dto.newPassword, user.hashedPassword);
      if (same) {
        throw new BadRequestException(
          "Le nouveau mot de passe doit différer de l'ancien.",
        );
      }
    }

    const newHash = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          hashedPassword: newHash,
          failedLoginAttempts: 0,
          loginLockLevel: 0,
          loginLockedUntil: null,
        },
      }),
      this.prisma.usedToken.create({ data: { jti: payload.jti } }),
    ]);

    return { message: 'Mot de passe modifié. Tu peux te connecter.' };
  }

  //Inscription par téléphone : envoie et vérification du code OTP premiere étape de la création du compte
  async sendPhoneOtp(dto: SendPhoneOtpDto) {
    await this.OtpService.sendPhoneOtp(dto.phone);

    //token temporaire qui transporte le numero jusqu'à la vérification
    const tempToken = this.jwt.sign(
      { phone: dto.phone, purpose: 'verify', jti: randomUUID() },
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
    const hash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    const data: Prisma.UserCreateInput = {
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
}
