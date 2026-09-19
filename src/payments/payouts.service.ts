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
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { OtpService } from 'src/otp/otp.service';
import { PAYOUT_MAX_AMOUNT, PAYOUT_MIN_AMOUNT } from 'src/common/constants';
import { buildPage, KeysetCursor, Paginated } from 'src/common/pagination';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import type { PaymentProvider } from './payment-provider.interface';
import { EarningsService } from './earnings.service';
import type { RequestPayoutDto } from './dto/request-payout.dto';

type PayoutOutcome = 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVIEW';

// Arrondi USD (2 décimales) ; le CDF est arrondi à l'entier séparément.
const round2 = (n: number) => Math.round(n * 100) / 100;

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

  // Étape 1 : valide (opérateur/devise, montant ∈ bornes, ≤ retirable de CETTE
  // devise), envoie un OTP à l'identifiant du compte, renvoie un tempToken typé
  // portant la devise + le montant. Le retrait s'opère dans la devise CHOISIE.
  async requestPayout(userId: string, dto: RequestPayoutDto) {
    const phoneNumber = this.normalizeMsisdn(dto.phoneNumber);
    if (!phoneNumber) {
      throw new BadRequestException('Numéro Mobile Money invalide.');
    }

    const currency = dto.currency;

    // Opérateur doit exister et supporter la devise demandée.
    const operators = await this.payment.getOperators();
    const op = operators.find((o) => o.code === dto.operator);
    if (!op || !op.available || !op.currencies.includes(currency)) {
      throw new BadRequestException(
        `Opérateur indisponible pour un retrait en ${currency}.`,
      );
    }

    const { withdrawable } = await this.earnings.getWithdrawable(
      userId,
      currency,
    );
    // Montant dans la devise : CDF en entier, USD à 2 décimales.
    const amount = dto.all
      ? withdrawable
      : currency === 'CDF'
        ? Math.round(dto.amount ?? 0)
        : round2(dto.amount ?? 0);

    if (amount < PAYOUT_MIN_AMOUNT) {
      throw new BadRequestException(
        `Le montant minimum de retrait est de ${PAYOUT_MIN_AMOUNT}.`,
      );
    }
    if (amount > withdrawable) {
      throw new BadRequestException(
        'Montant supérieur à votre solde retirable disponible.',
      );
    }
    // Filet défensif hérité (bornes pensées USD) : le vrai min/max PAR DEVISE
    // via l'active-conf de l'opérateur est appliqué au câblage sandbox.
    if (amount > PAYOUT_MAX_AMOUNT) {
      throw new BadRequestException(
        `Le montant maximum par retrait est de ${PAYOUT_MAX_AMOUNT}.`,
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
        currency,
        amount,
        phoneNumber,
        operator: dto.operator,
      },
      { expiresIn: '10m' },
    );
    return { tempToken, currency, amount };
  }

  // Étape 2 : vérifie token + OTP, débite le ledger + crée le Payout (transaction +
  // verrou par user), puis initPayout HORS transaction. Rejet EXPLICITE du provider
  // (statut retourné ≠ PENDING/ACCEPTED) → reversal + FAILED (l'argent n'est pas parti).
  // Erreur réseau/transport (throw) → Payout laissé PENDING, PAS de reversal : le
  // reaper (Task 5) réconciliera via checkPayoutStatus (source de vérité), car un
  // timeout peut survenir alors que le décaissement a bel et bien eu lieu côté PawaPay.
  async verifyPayout(userId: string, otp: string, tempToken: string) {
    let payload: {
      sub: string;
      type: string;
      currency: $Enums.Currency;
      amount: number;
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

    const currency = payload.currency;
    const amount = payload.amount;
    const payoutRef = randomUUID();

    // Débit atomique : verrou par user (sérialise 2 demandes concurrentes), re-vérif
    // du solde retirable de la devise, écriture PAYOUT_ORGANIZER (négatif) + Payout.
    const payout = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        userId,
      );
      // Lecture volontairement sur this.prisma (pas tx) : le verrou advisory par
      // user ci-dessus sérialise les vérifications concurrentes, donc un 2e appelant
      // ne lit ce solde qu'après le COMMIT de la transaction du 1er ; en READ
      // COMMITTED il voit alors le débit déjà écrit — pas de sur-retrait possible.
      const { withdrawable } = await this.earnings.getWithdrawable(
        userId,
        currency,
      );
      if (amount > withdrawable) {
        throw new BadRequestException('Solde retirable insuffisant.');
      }
      const created = await tx.payout.create({
        data: {
          payoutRef,
          userId,
          currency,
          amount,
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
          amount: -amount,
          currency,
          payoutId: created.id,
        },
      });
      return created;
    });

    // Initiation HORS transaction (appel réseau).
    try {
      const init = await this.payment.initPayout({
        payoutRef,
        amount,
        currency,
        operator: payload.operator,
        phoneNumber: payload.phoneNumber,
      });
      if (init.providerPayoutId) {
        await this.prisma.payout.update({
          where: { id: payout.id },
          data: { providerPayoutId: init.providerPayoutId },
        });
      }
      // Rejet EXPLICITE renvoyé par le provider : l'argent n'est pas parti, on
      // annule le débit tout de suite.
      if (init.status !== 'PENDING' && init.status !== 'ACCEPTED') {
        await this.reverse(payout.id, userId, amount, currency, 'FAILED');
        return {
          payoutRef,
          status: 'FAILED' as PayoutOutcome,
          currency,
          amount,
        };
      }
    } catch (err) {
      // Erreur réseau/transport : on ne sait pas si l'argent est parti ou non.
      // On NE reverse PAS et on NE marque PAS FAILED — le Payout reste PENDING,
      // le reaper le réconciliera via checkPayoutStatus.
      this.logger.error(
        `initPayout a échoué (${payoutRef}), Payout laissé PENDING pour réconciliation: ${String(err)}`,
      );
    }
    return {
      payoutRef,
      status: 'PENDING' as PayoutOutcome,
      currency,
      amount,
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
      // Déviation acceptée par rapport au chemin dépôt (qui route une divergence de
      // montant vers REVIEW) : ici le montant du payout est fixé côté serveur
      // (amount calculé par nos soins, pas saisi par l'acheteur), donc il n'y a pas
      // de divergence à arbitrer — APPROVED/ACCEPTED implique toujours COMPLETED.
      await this.prisma.payout.update({
        where: { id: payout.id },
        data: { status: 'COMPLETED', resolvedAt: new Date() },
      });
      return { payoutRef, status: 'COMPLETED' };
    }
    if (check.status === 'DECLINED') {
      await this.reverse(
        payout.id,
        payout.userId,
        payout.amount,
        payout.currency,
        'FAILED',
      );
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

  // Reversal idempotent : verrou advisory par user (première instruction de la
  // transaction) pour sérialiser les reverses concurrents du même user (course
  // webhook + reaper sur le même Payout), puis PENDING→(FAILED|REVIEW) +
  // PAYOUT_REVERSAL (+) écrit une seule fois (garde par count sur payoutId/type).
  private async reverse(
    payoutId: string,
    userId: string,
    amount: number,
    currency: $Enums.Currency,
    status: 'FAILED' | 'REVIEW',
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        userId,
      );
      const already = await tx.ledgerEntry.count({
        where: { payoutId, type: 'PAYOUT_REVERSAL' },
      });
      if (already === 0) {
        await tx.ledgerEntry.create({
          data: {
            account: 'ORGANIZER',
            userId,
            type: 'PAYOUT_REVERSAL',
            amount, // positif : restaure le solde (dans la devise du retrait)
            currency,
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

  // Callback payout PawaPay (public, signé). Miroir de PaymentsService.handleWebhook.
  // Signature fail-closed via le provider ; extraction de NOTRE référence (payoutId),
  // puis résolution via checkPayoutStatus (source de vérité) dans resolvePayout.
  async handlePayoutWebhook(
    rawBody: string,
    headers: Record<string, string>,
    context?: import('./payment-provider.interface').WebhookRequestContext,
  ): Promise<{ payoutRef: string; status: PayoutOutcome }> {
    if (!this.payment.verifyWebhookSignature(rawBody, headers, context)) {
      throw new UnauthorizedException('Signature de webhook invalide.');
    }
    let parsed: { payoutId?: string };
    try {
      parsed = JSON.parse(rawBody) as { payoutId?: string };
    } catch {
      throw new BadRequestException('Corps de webhook illisible.');
    }
    if (!parsed.payoutId) {
      throw new BadRequestException('Référence de payout absente du webhook.');
    }
    return this.resolvePayout(parsed.payoutId);
  }

  // Historique des retraits de l'utilisateur, tri chronologique décroissant,
  // pagination keyset sur (createdAt desc, payoutRef desc). Miroir de
  // EarningsService.getHistory.
  async listPayouts(
    userId: string,
    limit: number,
    cursor: KeysetCursor | null,
  ): Promise<Paginated<unknown>> {
    const rows = await this.prisma.payout.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: new Date(cursor.v) } },
                { createdAt: new Date(cursor.v), payoutRef: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { payoutRef: 'desc' }],
      take: limit + 1,
      select: {
        payoutRef: true,
        currency: true,
        amount: true,
        operator: true,
        destination: true,
        status: true,
        createdAt: true,
      },
    });

    return buildPage(rows, limit, (r) => ({
      v: r.createdAt.toISOString(),
      id: r.payoutRef,
    }));
  }

  // Suivi (polling front) : scope strict à l'utilisateur — un retrait d'un
  // autre utilisateur renvoie un 404 neutre, jamais un 403 (pas de fuite
  // d'existence).
  async getPayoutStatus(userId: string, payoutRef: string) {
    const p = await this.prisma.payout.findFirst({
      where: { payoutRef, userId },
      select: {
        payoutRef: true,
        status: true,
        currency: true,
        amount: true,
      },
    });
    if (!p) throw new NotFoundException('Retrait introuvable.');
    return p;
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
