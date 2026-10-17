import { BadRequestException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { EarningsService } from './earnings.service';

describe('PayoutsService', () => {
  let service: PayoutsService;
  let prisma: { user: { findUnique: jest.Mock } };
  let earnings: { getSummary: jest.Mock };
  let mail: { sendPayoutClaimEmail: jest.Mock };

  const user = {
    id: 'u1',
    firstname: 'Ada',
    lastname: 'Lovelace',
    email: 'ada@example.com',
    phone: null,
  };

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn().mockResolvedValue(user) } };
    earnings = {
      getSummary: jest.fn().mockResolvedValue({
        balances: [
          { currency: 'USD', balance: 85, gross: 100, commission: 15, net: 85 },
          { currency: 'CDF', balance: 600, gross: 700, commission: 100, net: 600 },
        ],
      }),
    };
    mail = { sendPayoutClaimEmail: jest.fn().mockResolvedValue(undefined) };
    service = new PayoutsService(
      prisma as unknown as PrismaService,
      earnings as unknown as EarningsService,
      mail as unknown as MailService,
    );
  });

  describe('claimNet', () => {
    it('recalcule le montant depuis le solde ledger et notifie l’équipe Vybe', async () => {
      const res = await service.claimNet('u1', 'CDF', '243812345678');

      expect(res).toEqual({ ok: true, amount: 600, currency: 'CDF' });
      // Le montant envoyé au mail est celui du ledger (jamais fourni par le client).
      expect(mail.sendPayoutClaimEmail).toHaveBeenCalledWith({
        user,
        currency: 'CDF',
        amount: 600,
        mmoNumber: '243812345678',
      });
    });

    it('rejette si aucun solde dans la devise demandée', async () => {
      earnings.getSummary.mockResolvedValue({ balances: [] });
      await expect(
        service.claimNet('u1', 'USD', '243812345678'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
    });

    it('rejette un solde nul ou négatif', async () => {
      earnings.getSummary.mockResolvedValue({
        balances: [
          { currency: 'USD', balance: 0, gross: 0, commission: 0, net: 0 },
        ],
      });
      await expect(
        service.claimNet('u1', 'USD', '243812345678'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
    });

    it('rejette si l’utilisateur est introuvable', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.claimNet('u1', 'USD', '243812345678'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
    });
  });
});
