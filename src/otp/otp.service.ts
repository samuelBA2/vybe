import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { SmsService } from 'src/sms/sms.service';
import { randomInt } from 'crypto';
import * as bcrypt from 'bcrypt';
import { MailService } from 'src/mail/mail.service';
import { PrismaService } from 'src/prisma/prisma.service';

const OTP_EXPIRATION_MS = 5 * 60 * 1000; // 5 minutes
const RESEND_COOLDOWN_MS = 5 * 60 * 1000; // délai minimum entre deux envois
const BLOCK_DURATION_MS = 20 * 60 * 1000; // durée du blocage après MAX tentatives
const MAX_VERIFICATION_ATTEMPTS = 5;

// Message commun (email + SMS) accompagnant le code de suppression de compte.
const ACCOUNT_DELETION_NOTICE =
  'Voici le code de sécurité que vous devez saisir pour poursuivre le processus de suppression de votre compte. ' +
  "Sachez qu'après avoir supprimé votre compte, il restera stocké en base de données pendant un délai de deux semaines, " +
  'pour vous permettre de revenir en arrière si vous le souhaitez.';

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly smsService: SmsService,
    private readonly mailService: MailService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── Inscription ────────────────────────────────────────────────────────────

  async sendEmailOtp(email: string) {
    const exists = await this.prisma.user.findUnique({ where: { email } });

    if (exists) {
      await this.mailService.sendOtp(
        email,
        "Quelqu'un tente de s'inscrire avec votre adresse email vybe. Si ce n'est pas vous, ignorez ce message.",
      );
      return { message: 'Un code de verification vous a été envoyé par email' };
    }

    const otp = this.generateOtp();
    await this.persistOtp(email, otp);

    try {
      await this.mailService.sendOtp(email, otp);
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi de l'OTP à ${email}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de vérification. Veuillez réessayer plus tard.",
      );
    }
    return { message: 'Un code de verification vous a été envoyé par email' };
  }

  async sendPhoneOtp(phone: string) {
    const exists = await this.prisma.user.findUnique({ where: { phone } });
    if (exists) {
      await this.smsService.sendOtp(
        phone,
        "Quelqu'un tente de s'inscrire avec votre numéro vybe. Si ce n'est pas vous, ignorez ce message.",
      );
      return { message: 'Un code de verification vous a été envoyé' };
    }
    const otp = this.generateOtp();
    await this.persistOtp(phone, otp);

    try {
      await this.smsService.sendOtp(
        phone,
        `Votre code de verification vybe :${otp}`,
      );
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi de l'OTP à ${phone}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de vérification. Veuillez réessayer plus tard.",
      );
    }
    return { message: 'Un code de verification vous a été envoyé' };
  }

  // ─── Connexion (avec cooldown resend + blocage) ──────────────────────────────

  async sendLoginEmailOtp(email: string): Promise<void> {
    await this.checkBlock(email);
    await this.checkResendCooldown(email);

    const otp = this.generateOtp();
    await this.persistOtp(email, otp);

    try {
      await this.mailService.sendOtp(email, otp);
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du code de connexion à ${email}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de vérification. Veuillez réessayer plus tard.",
      );
    }
  }

  async sendLoginPhoneOtp(phone: string): Promise<void> {
    await this.checkBlock(phone);
    await this.checkResendCooldown(phone);

    const otp = this.generateOtp();
    await this.persistOtp(phone, otp);

    try {
      await this.smsService.sendOtp(
        phone,
        `Votre code de connexion vybe : ${otp}`,
      );
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du code de connexion à ${phone}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de vérification. Veuillez réessayer plus tard.",
      );
    }
  }

  // ─── Suppression de compte (avec cooldown resend + blocage) ──────────────────

  async sendAccountDeletionEmailOtp(email: string): Promise<void> {
    await this.checkBlock(email);
    await this.checkResendCooldown(email);

    const otp = this.generateOtp();
    await this.persistOtp(email, otp);

    try {
      await this.mailService.sendAccountDeletionOtp(email, otp);
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du code de suppression à ${email}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de sécurité. Veuillez réessayer plus tard.",
      );
    }
  }

  async sendAccountDeletionPhoneOtp(phone: string): Promise<void> {
    await this.checkBlock(phone);
    await this.checkResendCooldown(phone);

    const otp = this.generateOtp();
    await this.persistOtp(phone, otp);

    try {
      await this.smsService.sendOtp(
        phone,
        `${ACCOUNT_DELETION_NOTICE} Votre code de sécurité : ${otp}`,
      );
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du code de suppression à ${phone}: ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le code de sécurité. Veuillez réessayer plus tard.",
      );
    }
  }

  // ─── Vérification OTP ────────────────────────────────────────────────────────

  async verifyOtp(identifier: string, code: string): Promise<void> {
    // 1. Blocage actif ?
    await this.checkBlock(identifier);

    // 2. OTP valide en base ?
    const record = await this.prisma.otpVerification.findFirst({
      where: { identifier, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) {
      throw new BadRequestException('Code OTP invalide ou expiré');
    }

    // 3. Code incorrect (comparaison avec le hash stocké)
    const matches = await bcrypt.compare(code, record.code);
    if (!matches) {
      const newAttempts = record.attempts + 1;

      if (newAttempts >= MAX_VERIFICATION_ATTEMPTS) {
        const blockedUntil = new Date(Date.now() + BLOCK_DURATION_MS);
        await this.prisma.otpVerification.update({
          where: { id: record.id },
          data: { attempts: newAttempts, used: true, blockedUntil },
        });
        throw new BadRequestException(
          'Trop de tentatives incorrectes. Réessayez dans 20 minutes.',
        );
      }

      // Incrément atomique côté base : évite le lost update si deux tentatives
      // arrivent simultanément (chaque échec est bien comptabilisé).
      await this.prisma.otpVerification.update({
        where: { id: record.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException(
        `Code OTP invalide. ${MAX_VERIFICATION_ATTEMPTS - newAttempts} tentative(s) restante(s).`,
      );
    }

    // 4. Code correct → invalider l'OTP
    await this.prisma.otpVerification.update({
      where: { id: record.id },
      data: { used: true },
    });
  }

  // ─── Utilitaires privés ──────────────────────────────────────────────────────

  private async checkBlock(identifier: string): Promise<void> {
    const blocked = await this.prisma.otpVerification.findFirst({
      where: { identifier, blockedUntil: { gt: new Date() } },
      orderBy: { blockedUntil: 'desc' },
    });
    if (blocked) {
      const remainingMin = Math.ceil(
        (blocked.blockedUntil!.getTime() - Date.now()) / 60000,
      );
      throw new BadRequestException(
        `Trop de tentatives incorrectes. Réessayez dans ${remainingMin} minute(s).`,
      );
    }
  }

  private async checkResendCooldown(identifier: string): Promise<void> {
    const recent = await this.prisma.otpVerification.findFirst({
      where: { identifier, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (recent) {
      const elapsed = Date.now() - recent.createdAt.getTime();
      if (elapsed < RESEND_COOLDOWN_MS) {
        const remainingMin = Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 60000);
        throw new BadRequestException(
          `Veuillez attendre ${remainingMin} minute(s) avant de redemander un code.`,
        );
      }
    }
  }

  // Pas de contrainte d'unicité globale : elle réduirait l'entropie et
  // créerait une course en base. L'OTP est lié à un identifier, un doublon
  // entre deux utilisateurs est sans conséquence.
  private generateOtp(): string {
    return String(randomInt(100000, 1000000));
  }

  private async persistOtp(identifier: string, code: string): Promise<void> {
    // Un OTP est un secret d'authentification : on ne stocke que son hash,
    // une fuite de la base ne doit pas exposer les codes actifs.
    const codeHash = await bcrypt.hash(code, 10);
    const expiresAt = new Date(Date.now() + OTP_EXPIRATION_MS);
    await this.prisma.$transaction(async (tx) => {
      await tx.otpVerification.updateMany({
        where: { identifier, used: false },
        data: { used: true },
      });
      await tx.otpVerification.create({
        data: {
          identifier,
          code: codeHash,
          expiresAt,
          used: false,
          attempts: 0,
        },
      });
    });
  }
}
