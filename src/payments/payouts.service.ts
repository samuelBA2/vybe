import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { EarningsService } from './earnings.service';

const RESEND_COOLDOWN_MS = 60_000;

export interface PayoutClaimView {
  id: string;
  status: $Enums.PayoutClaimStatus;
  amount: number;
  currency: $Enums.Currency;
  mmoNumber: string;
  createdAt: Date;
}

// Retrait MANUEL assisté (V1). La réclamation est PERSISTÉE et le solde est déduit
// dès la demande (écriture ledger PAYOUT_ORGANIZER négative). L'équipe Vybe confirme
// (statut seulement) ou rejette (restaure le solde) via magic-link dans le mail.
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly earnings: EarningsService,
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async claimNet(
    userId: string,
    currency: $Enums.Currency,
    mmoNumber: string,
  ): Promise<PayoutClaimView> {
    // Une seule réclamation active par (user, devise) : on ne re-déduit jamais.
    const active = await this.prisma.payoutClaim.findFirst({
      where: { userId, currency, status: 'SENT' },
    });
    if (active) return this.toView(active);

    // Solde net réel dans CETTE devise (source de vérité = ledger ORGANIZER).
    const { balances } = await this.earnings.getSummary(userId);
    const bal = balances.find((b) => b.currency === currency);
    if (!bal || bal.balance <= 0) {
      throw new BadRequestException(
        'Aucun solde à réclamer dans cette devise.',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const jti = randomUUID();
    const claim = await this.prisma.$transaction(async (tx) => {
      const c = await tx.payoutClaim.create({
        data: {
          userId,
          currency,
          amount: bal.balance,
          mmoNumber,
          jti,
          status: 'SENT',
        },
      });
      await tx.ledgerEntry.create({
        data: {
          account: 'ORGANIZER',
          userId,
          type: 'PAYOUT_ORGANIZER',
          amount: -bal.balance, // débit : déduction à la demande
          currency,
        },
      });
      return c;
    });

    const { confirmUrl, rejectUrl } = this.buildDecisionUrls(
      claim.id,
      claim.jti,
    );
    await this.mail.sendPayoutClaimEmail({
      user,
      currency,
      amount: claim.amount,
      mmoNumber,
      confirmUrl,
      rejectUrl,
    });

    this.logger.log(
      `Réclamation créée (user ${userId}, ${claim.amount} ${currency}, MMO ${mmoNumber})`,
    );
    return this.toView(claim);
  }

  async resendClaim(userId: string, claimId: string): Promise<{ ok: true }> {
    const claim = await this.prisma.payoutClaim.findUnique({
      where: { id: claimId },
    });
    if (!claim || claim.userId !== userId) {
      throw new NotFoundException('Réclamation introuvable.');
    }
    if (claim.status !== 'SENT') {
      throw new BadRequestException('Cette demande a déjà été traitée.');
    }
    if (Date.now() - claim.lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
      throw new BadRequestException('Patiente une minute avant de renvoyer.');
    }
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        phone: true,
      },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable.');

    const { confirmUrl, rejectUrl } = this.buildDecisionUrls(
      claim.id,
      claim.jti,
    );
    await this.mail.sendPayoutClaimEmail({
      user,
      currency: claim.currency,
      amount: claim.amount,
      mmoNumber: claim.mmoNumber,
      confirmUrl,
      rejectUrl,
    });
    await this.prisma.payoutClaim.update({
      where: { id: claim.id },
      data: { lastSentAt: new Date() },
    });
    return { ok: true };
  }

  async getCurrentClaim(
    userId: string,
    currency: $Enums.Currency,
  ): Promise<PayoutClaimView | null> {
    const claim = await this.prisma.payoutClaim.findFirst({
      where: { userId, currency },
      orderBy: { createdAt: 'desc' },
    });
    return claim ? this.toView(claim) : null;
  }

  private buildDecisionUrls(claimId: string, jti: string) {
    const token = this.jwt.sign(
      { sub: claimId, type: 'payout-claim', jti },
      { expiresIn: '7d' },
    );
    const base = this.config.get<string>('API_BASE_URL') ?? '';
    const t = encodeURIComponent(token);
    return {
      confirmUrl: `${base}/payouts/decision?token=${t}&decision=confirm`,
      rejectUrl: `${base}/payouts/decision?token=${t}&decision=reject`,
    };
  }

  private toView(c: {
    id: string;
    status: $Enums.PayoutClaimStatus;
    amount: number;
    currency: $Enums.Currency;
    mmoNumber: string;
    createdAt: Date;
  }): PayoutClaimView {
    return {
      id: c.id,
      status: c.status,
      amount: c.amount,
      currency: c.currency,
      mmoNumber: c.mmoNumber,
      createdAt: c.createdAt,
    };
  }
}
