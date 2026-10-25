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
import { MIN_CLAIM_AMOUNT } from 'src/common/constants';

const round2 = (n: number) => Math.round(n * 100) / 100;
// Quantifie un montant dans sa devise : CDF entier, USD 2 décimales (miroir EarningsService).
const quantize = (n: number, currency: $Enums.Currency) =>
  currency === 'CDF' ? Math.round(n) : round2(n);

const RESEND_COOLDOWN_MS = 60_000;
const RESUME_WINDOW_MS = 15 * 60_000; // la barre d'une réclamation terminée reste visible 15 min

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
    private readonly mail: MailService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async claimNet(
    userId: string,
    currency: $Enums.Currency,
    mmoNumber: string,
    amount: number,
  ): Promise<PayoutClaimView> {
    // Validation de FORME du montant (indépendante du solde) : rejet rapide, sans verrou.
    this.assertAmountShape(amount, currency);

    // Chemin rapide : réclamation active existante → pas de nouvelle déduction.
    const existing = await this.prisma.payoutClaim.findFirst({
      where: { userId, currency, status: 'SENT' },
    });
    if (existing) return this.toView(existing);

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
    const { claim, created } = await this.prisma.$transaction(async (tx) => {
      // Sérialise les demandes concurrentes de ce (user, devise) : empêche la
      // double déduction sur double-clic. Verrou relâché en fin de transaction.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`payout:${userId}:${currency}`}))`;
      const active = await tx.payoutClaim.findFirst({
        where: { userId, currency, status: 'SENT' },
      });
      if (active) return { claim: active, created: false };

      // ANTI-SURFACTURATION : solde réel recalculé DANS la transaction (source de
      // vérité = ledger ORGANIZER). Le montant demandé ne peut jamais le dépasser.
      const agg = await tx.ledgerEntry.aggregate({
        _sum: { amount: true },
        where: { userId, account: 'ORGANIZER', currency },
      });
      const balance = quantize(agg._sum.amount ?? 0, currency);
      if (amount > balance) {
        throw new BadRequestException('Montant supérieur au solde disponible.');
      }

      const c = await tx.payoutClaim.create({
        data: { userId, currency, amount, mmoNumber, jti, status: 'SENT' },
      });
      await tx.ledgerEntry.create({
        data: {
          account: 'ORGANIZER',
          userId,
          type: 'PAYOUT_ORGANIZER',
          amount: -amount, // débit : déduction du montant demandé
          currency,
        },
      });
      return { claim: c, created: true };
    });

    if (created) {
      const { confirmUrl, rejectUrl } = this.buildDecisionUrls(
        claim.id,
        claim.jti,
      );
      try {
        await this.mail.sendPayoutClaimEmail({
          user,
          currency,
          amount: claim.amount,
          mmoNumber,
          confirmUrl,
          rejectUrl,
        });
      } catch (e) {
        this.logger.error(
          `Envoi du mail de réclamation échoué (claim ${claim.id})`,
          e as Error,
        );
      }
    }

    this.logger.log(
      `Réclamation ${created ? 'créée' : 'déjà active'} (user ${userId}, ${claim.amount} ${currency})`,
    );
    return this.toView(claim);
  }

  // Validation de forme d'un montant de retrait, indépendante du solde.
  private assertAmountShape(amount: number, currency: $Enums.Currency): void {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException('Montant invalide.');
    }
    if (quantize(amount, currency) !== amount) {
      throw new BadRequestException(
        currency === 'CDF'
          ? 'Le montant en CDF doit être un entier.'
          : 'Le montant en USD ne peut avoir plus de 2 décimales.',
      );
    }
    if (amount < MIN_CLAIM_AMOUNT[currency]) {
      throw new BadRequestException(
        `Montant minimum : ${MIN_CLAIM_AMOUNT[currency]} ${currency}.`,
      );
    }
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
    if (!claim) return null;
    // Une réclamation terminée depuis longtemps ne doit plus bloquer le formulaire :
    // on la masque passé la fenêtre de reprise (le statut en base reste correct).
    if (
      claim.status !== 'SENT' &&
      (!claim.decidedAt ||
        Date.now() - claim.decidedAt.getTime() > RESUME_WINDOW_MS)
    ) {
      return null;
    }
    return this.toView(claim);
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
