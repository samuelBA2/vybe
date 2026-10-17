import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { EarningsService } from './earnings.service';

// Retrait MANUEL assisté (V1). On contourne volontairement un flux cashout
// self-service : le client ne déclenche pas le virement lui-même. Il « réclame »
// son net, Vybe reçoit un mail et effectue l'envoi Mobile Money à la main.
//
// SÉCURITÉ : le montant réclamé n'est JAMAIS celui envoyé par le client ; il est
// recalculé ici depuis le solde ledger (EarningsService = même source que l'UI).
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly earnings: EarningsService,
    private readonly mail: MailService,
  ) {}

  // Enregistre l'intention de retrait du net dans `currency` sur `mmoNumber` et
  // alerte l'équipe Vybe par mail. Retourne le montant retenu pour accusé client.
  async claimNet(
    userId: string,
    currency: $Enums.Currency,
    mmoNumber: string,
  ): Promise<{ ok: true; amount: number; currency: $Enums.Currency }> {
    // Solde net réel dans CETTE devise (ledger ORGANIZER). Source de vérité.
    const { balances } = await this.earnings.getSummary(userId);
    const bal = balances.find((b) => b.currency === currency);
    if (!bal || bal.balance <= 0) {
      throw new BadRequestException(
        'Aucun solde à réclamer dans cette devise.',
      );
    }

    // Identité de l'organisateur, pour que l'équipe le recontacte et vérifie.
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
    if (!user) {
      throw new BadRequestException('Utilisateur introuvable.');
    }

    await this.mail.sendPayoutClaimEmail({
      user,
      currency,
      amount: bal.balance,
      mmoNumber,
    });

    this.logger.log(
      `Demande de retrait net relayée (user ${userId}, ${bal.balance} ${currency}, MMO ${mmoNumber})`,
    );

    return { ok: true, amount: bal.balance, currency };
  }
}
