import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from 'src/prisma/prisma.service';

interface PayoutTokenPayload {
  sub: string;
  type: string;
  jti: string;
}

// Décision de l'équipe Vybe sur une réclamation de retrait, via magic-link du mail
// (calqué sur EventModerationService). Confirm = statut seulement ; Reject = statut
// + écriture ledger inverse qui restaure le solde du client.
@Injectable()
export class PayoutModerationService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async decide(
    token: string,
    decision: 'confirm' | 'reject',
  ): Promise<{ message: string }> {
    let payload: PayoutTokenPayload;
    try {
      payload = this.jwt.verify<PayoutTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Lien invalide ou expiré.');
    }
    if (payload.type !== 'payout-claim') {
      throw new ForbiddenException('Type de token non autorisé.');
    }

    const claim = await this.prisma.payoutClaim.findUnique({
      where: { id: payload.sub },
    });
    if (!claim) throw new NotFoundException('Réclamation introuvable.');
    if (claim.status !== 'SENT') {
      throw new ConflictException('Cette demande a déjà été traitée.');
    }

    const confirmed = decision === 'confirm';
    await this.prisma.$transaction(async (tx) => {
      // Compare-and-swap atomique : seule une décision concurrente gagnante passe.
      const res = await tx.payoutClaim.updateMany({
        where: { id: claim.id, status: 'SENT' },
        data: {
          status: confirmed ? 'CONFIRMED' : 'CANCELLED',
          decidedAt: new Date(),
        },
      });
      if (res.count === 0) {
        // Une décision concurrente a déjà traité cette réclamation.
        throw new ConflictException('Cette demande a déjà été traitée.');
      }
      if (!confirmed) {
        // Restaure le solde : écriture inverse (crédit) du montant déduit.
        await tx.ledgerEntry.create({
          data: {
            account: 'ORGANIZER',
            userId: claim.userId,
            type: 'PAYOUT_ORGANIZER',
            amount: claim.amount,
            currency: claim.currency,
          },
        });
      }
    });

    return {
      message: confirmed
        ? 'Paiement confirmé. Le client en est informé.'
        : 'Demande rejetée. Le solde du client a été restauré.',
    };
  }
}
