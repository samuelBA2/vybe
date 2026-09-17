import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { OtpService } from 'src/otp/otp.service';
import {
  PAYOUT_MAX_AMOUNT,
  PAYOUT_MIN_AMOUNT,
  USD_TO_CDF_RATE,
} from 'src/common/constants';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import type { PaymentProvider } from './payment-provider.interface';
import { EarningsService } from './earnings.service';

interface RequestPayoutDto {
  amountUSD?: number;
  all?: boolean;
  phoneNumber: string;
  operator: string;
}
type PayoutOutcome = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVIEW';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
    private readonly otp: OtpService,
    private readonly jwt: JwtService,
    private readonly earnings: EarningsService,
  ) {}

  // Étape 1 : valide (opérateur/devise, montant ∈ bornes, ≤ retirable), envoie un
  // OTP à l'identifiant du compte, renvoie un tempToken typé + aperçu CDF.
  async requestPayout(userId: string, dto: RequestPayoutDto) {
    const phoneNumber = this.normalizeMsisdn(dto.phoneNumber);
    if (!phoneNumber) {
      throw new BadRequestException('Numéro Mobile Money invalide.');
    }

    // Opérateur doit exister et supporter le CDF (payout CDF).
    const operators = await this.payment.getOperators();
    const op = operators.find((o) => o.code === dto.operator);
    if (!op || !op.available || !op.currencies.includes('CDF')) {
      throw new BadRequestException(
        'Opérateur indisponible pour un retrait en CDF.',
      );
    }

    const { withdrawableUSD } = await this.earnings.getWithdrawable(userId);
    const amountUSD = dto.all
      ? withdrawableUSD
      : Math.round((dto.amountUSD ?? 0) * 100) / 100;

    if (amountUSD < PAYOUT_MIN_AMOUNT) {
      throw new BadRequestException(
        `Le montant minimum de retrait est de ${PAYOUT_MIN_AMOUNT} USD.`,
      );
    }
    if (amountUSD > withdrawableUSD) {
      throw new BadRequestException(
        'Montant supérieur à votre solde retirable disponible.',
      );
    }
    // Filet défensif (le plafond opérateur exact est appliqué au câblage sandbox).
    if (amountUSD > PAYOUT_MAX_AMOUNT) {
      throw new BadRequestException(
        `Le montant maximum par retrait est de ${PAYOUT_MAX_AMOUNT} USD.`,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const identifier = user.email ?? user.phone;
    if (!identifier) {
      throw new BadRequestException(
        'Aucun email ni téléphone associé au compte.',
      );
    }
    if (user.email) await this.otp.sendPayoutEmailOtp(user.email);
    else await this.otp.sendPayoutPhoneOtp(user.phone!);

    const tempToken = this.jwt.sign(
      {
        sub: userId,
        type: 'payout',
        amountUSD,
        phoneNumber,
        operator: dto.operator,
      },
      { expiresIn: '10m' },
    );
    const rate = USD_TO_CDF_RATE;
    return {
      tempToken,
      amountUSD,
      amountCDF: Math.round(amountUSD * rate),
      rate,
    };
  }

  // Étape 2 : vérifie token + OTP, débite le ledger + crée le Payout (transaction +
  // verrou par user), puis initPayout HORS transaction. Échec init → reversal + FAILED.
  async verifyPayout(userId: string, otp: string, tempToken: string) {
    let payload: {
      sub: string;
      type: string;
      amountUSD: number;
      phoneNumber: string;
      operator: string;
    };
    try {
      payload = this.jwt.verify(tempToken);
    } catch {
      throw new UnauthorizedException('Token invalide ou expiré.');
    }
    if (payload.type !== 'payout')
      throw new ForbiddenException('Type de token non autorisé.');
    if (payload.sub !== userId)
      throw new ForbiddenException('Token non autorisé.');

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');
    const identifier = user.email ?? user.phone;
    await this.otp.verifyOtp(identifier!, otp);

    const rate = USD_TO_CDF_RATE;
    const amountUSD = payload.amountUSD;
    const amountCDF = Math.round(amountUSD * rate);
    const payoutRef = randomUUID();

    // Débit atomique : verrou par user (sérialise 2 demandes concurrentes), re-vérif
    // du solde retirable, écriture PAYOUT_ORGANIZER (négatif) + Payout PENDING.
    const payout = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        userId,
      );
      const { withdrawableUSD } = await this.earnings.getWithdrawable(userId);
      if (amountUSD > withdrawableUSD) {
        throw new BadRequestException('Solde retirable insuffisant.');
      }
      const created = await tx.payout.create({
        data: {
          payoutRef,
          userId,
          amountUSD,
          amountCDF,
          rate,
          operator: payload.operator,
          destination: payload.phoneNumber,
          status: 'PENDING',
        },
      });
      await tx.ledgerEntry.create({
        data: {
          account: 'ORGANIZER',
          userId,
          type: 'PAYOUT_ORGANIZER',
          amount: -amountUSD,
          currency: 'USD',
          payoutId: created.id,
        },
      });
      return created;
    });

    // Initiation HORS transaction (appel réseau).
    let initStatus: string;
    try {
      const init = await this.payment.initPayout({
        payoutRef,
        amount: amountCDF,
        currency: 'CDF',
        operator: payload.operator,
        phoneNumber: payload.phoneNumber,
      });
      initStatus = init.status;
      if (init.providerPayoutId) {
        await this.prisma.payout.update({
          where: { id: payout.id },
          data: { providerPayoutId: init.providerPayoutId },
        });
      }
    } catch (err) {
      this.logger.error(`initPayout a échoué (${payoutRef}): ${String(err)}`);
      initStatus = 'DECLINED';
    }

    if (initStatus !== 'PENDING' && initStatus !== 'ACCEPTED') {
      await this.reverse(payout.id, userId, amountUSD, 'FAILED');
      return {
        payoutRef,
        status: 'FAILED' as PayoutOutcome,
        amountUSD,
        amountCDF,
      };
    }
    return {
      payoutRef,
      status: 'PENDING' as PayoutOutcome,
      amountUSD,
      amountCDF,
    };
  }

  // Résolution async (webhook + reaper). checkPayoutStatus = source de vérité.
  async resolvePayout(
    payoutRef: string,
    opts?: { markStuck?: boolean },
  ): Promise<{ payoutRef: string; status: PayoutOutcome }> {
    const payout = await this.prisma.payout.findUnique({
      where: { payoutRef },
    });
    if (!payout) throw new NotFoundException('Retrait introuvable.');
    if (payout.status !== 'PENDING') {
      return { payoutRef, status: payout.status as PayoutOutcome };
    }

    const check = await this.payment.checkPayoutStatus(payoutRef);

    if (check.status === 'APPROVED' || check.status === 'ACCEPTED') {
      await this.prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'COMPLETED', resolvedAt: new Date() },
      });
      return { payoutRef, status: 'COMPLETED' };
    }
    if (check.status === 'DECLINED') {
      await this.reverse(payout.id, payout.userId, payout.amountUSD, 'FAILED');
      return { payoutRef, status: 'FAILED' };
    }
    // Toujours en cours : le reaper (markStuck) peut basculer en REVIEW.
    if (opts?.markStuck) {
      await this.prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'REVIEW', resolvedAt: new Date() },
      });
      return { payoutRef, status: 'REVIEW' };
    }
    return { payoutRef, status: 'PENDING' };
  }

  // Reversal idempotent : PENDING→(FAILED|REVIEW) + PAYOUT_REVERSAL (+) écrit une
  // seule fois (garde par count sur payoutId/type), dans une transaction.
  private async reverse(
    payoutId: string,
    userId: string,
    amountUSD: number,
    status: 'FAILED' | 'REVIEW',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const already = await tx.ledgerEntry.count({
        where: { payoutId, type: 'PAYOUT_REVERSAL' },
      });
      if (already === 0) {
        await tx.ledgerEntry.create({
          data: {
            account: 'ORGANIZER',
            userId,
            type: 'PAYOUT_REVERSAL',
            amount: amountUSD, // positif : restaure le solde
            currency: 'USD',
            payoutId,
          },
        });
      }
      await tx.payout.update({
        where: { id: payoutId },
        data: { status, resolvedAt: new Date() },
      });
    });
  }

  // Normalise un numéro RDC en 12 chiffres (243XXXXXXXXX) ou null. (Miroir de la
  // logique front normalizeMobileNumber, côté serveur = source de vérité.)
  private normalizeMsisdn(raw: string): string | null {
    const digits = (raw ?? '').replace(/\D/g, '');
    if (/^243\d{9}$/.test(digits)) return digits;
    if (/^0\d{9}$/.test(digits)) return `243${digits.slice(1)}`;
    if (/^\d{9}$/.test(digits)) return `243${digits}`;
    return null;
  }
}
