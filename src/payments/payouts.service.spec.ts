import { PayoutsService } from './payouts.service';
import { ForbiddenException } from '@nestjs/common';

describe('PayoutsService', () => {
  let service: PayoutsService;
  let prisma: any;
  let provider: any;
  let otp: any;
  let jwt: any;
  let earnings: any;

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'org-1', email: 'a@b.co', phone: null }) },
      payout: {
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'p1', ...data })),
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
      },
      ledgerEntry: { create: jest.fn().mockResolvedValue({}), count: jest.fn().mockResolvedValue(0) },
      $transaction: jest.fn().mockImplementation(async (fn: any) => fn(prisma)),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    provider = {
      initPayout: jest.fn().mockResolvedValue({ payoutRef: 'p1', status: 'PENDING' }),
      checkPayoutStatus: jest.fn(),
      getOperators: jest.fn().mockResolvedValue([
        { code: 'VODACOM_MPESA_COD', name: 'Vodacom', available: true, currencies: ['CDF', 'USD'] },
      ]),
    };
    otp = { sendPayoutEmailOtp: jest.fn(), sendPayoutPhoneOtp: jest.fn(), verifyOtp: jest.fn() };
    jwt = {
      sign: jest.fn().mockReturnValue('temp.jwt'),
      verify: jest.fn().mockReturnValue({
        sub: 'org-1', type: 'payout', amountUSD: 50, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD',
      }),
    };
    earnings = { getWithdrawable: jest.fn().mockResolvedValue({ withdrawableUSD: 100, withdrawableCDF: 225000 }) };

    service = new PayoutsService(prisma, provider, otp, jwt, earnings);
  });

  describe('requestPayout', () => {
    it('valide, envoie OTP, renvoie tempToken + aperçu CDF', async () => {
      const res = await service.requestPayout('org-1', {
        amountUSD: 50, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD',
      });
      expect(otp.sendPayoutEmailOtp).toHaveBeenCalledWith('a@b.co');
      expect(res.tempToken).toBe('temp.jwt');
      expect(res.amountUSD).toBe(50);
      expect(res.amountCDF).toBe(Math.round(50 * res.rate));
    });

    it('refuse un montant > solde retirable', async () => {
      await expect(
        service.requestPayout('org-1', { amountUSD: 500, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' }),
      ).rejects.toThrow();
    });

    it('all:true retire tout le solde maturé', async () => {
      const res = await service.requestPayout('org-1', { all: true, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' });
      expect(res.amountUSD).toBe(100);
    });
  });

  describe('verifyPayout', () => {
    it('débite le ledger (négatif) + crée Payout PENDING + initPayout', async () => {
      const res = await service.verifyPayout('org-1', '123456', 'temp.jwt');
      const ledgerArg = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(ledgerArg.type).toBe('PAYOUT_ORGANIZER');
      expect(ledgerArg.amount).toBeLessThan(0);
      expect(ledgerArg.payoutId).toBe('p1');
      expect(provider.initPayout).toHaveBeenCalled();
      expect(res.status).toBe('PENDING');
    });

    it('échec init → reversal + Payout FAILED', async () => {
      provider.initPayout.mockResolvedValue({ payoutRef: 'p1', status: 'DECLINED' });
      const res = await service.verifyPayout('org-1', '123456', 'temp.jwt');
      const reversal = prisma.ledgerEntry.create.mock.calls.find(
        (c: any[]) => c[0].data.type === 'PAYOUT_REVERSAL',
      );
      expect(reversal[0].data.amount).toBeGreaterThan(0);
      expect(res.status).toBe('FAILED');
    });

    it('initPayout qui lève (erreur transport) → Payout reste PENDING, PAS de reversal', async () => {
      provider.initPayout.mockRejectedValue(new Error('network'));
      const res = await service.verifyPayout('org-1', '123456', 'temp.jwt');
      expect(res.status).toBe('PENDING');
      const reversal = prisma.ledgerEntry.create.mock.calls.find(
        (c: any[]) => c[0].data.type === 'PAYOUT_REVERSAL',
      );
      expect(reversal).toBeUndefined();
      expect(prisma.payout.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
      );
    });

    it('refuse un token dont le type n\'est pas "payout" (aucun mouvement d\'argent)', async () => {
      jwt.verify.mockReturnValue({
        sub: 'org-1',
        type: 'account-deletion',
        amountUSD: 50,
        phoneNumber: '243812345678',
        operator: 'VODACOM_MPESA_COD',
      });
      await expect(
        service.verifyPayout('org-1', '123456', 'tok'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(provider.initPayout).not.toHaveBeenCalled();
    });

    it('refuse un token dont le sub ne correspond pas à userId (aucun mouvement d\'argent)', async () => {
      jwt.verify.mockReturnValue({
        sub: 'someone-else',
        type: 'payout',
        amountUSD: 50,
        phoneNumber: '243812345678',
        operator: 'VODACOM_MPESA_COD',
      });
      await expect(
        service.verifyPayout('org-1', '123456', 'tok'),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
      expect(provider.initPayout).not.toHaveBeenCalled();
    });
  });

  describe('resolvePayout', () => {
    it('APPROVED → COMPLETED', async () => {
      prisma.payout.findUnique.mockResolvedValue({ id: 'p1', payoutRef: 'ref', userId: 'org-1', amountUSD: 50, status: 'PENDING' });
      provider.checkPayoutStatus.mockResolvedValue({ status: 'APPROVED' });
      const res = await service.resolvePayout('ref');
      expect(res.status).toBe('COMPLETED');
    });

    it('DECLINED → FAILED + reversal (une seule fois)', async () => {
      prisma.payout.findUnique.mockResolvedValue({ id: 'p1', payoutRef: 'ref', userId: 'org-1', amountUSD: 50, status: 'PENDING' });
      provider.checkPayoutStatus.mockResolvedValue({ status: 'DECLINED' });
      const res = await service.resolvePayout('ref');
      expect(res.status).toBe('FAILED');
      const reversal = prisma.ledgerEntry.create.mock.calls.find(
        (c: any[]) => c[0].data.type === 'PAYOUT_REVERSAL',
      );
      expect(reversal).toBeTruthy();
    });

    it('DECLINED → reverse() prend le verrou advisory par user avant d\'écrire la reversal', async () => {
      prisma.payout.findUnique.mockResolvedValue({ id: 'p1', payoutRef: 'ref', userId: 'org-1', amountUSD: 50, status: 'PENDING' });
      provider.checkPayoutStatus.mockResolvedValue({ status: 'DECLINED' });
      await service.resolvePayout('ref');
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        expect.anything(),
      );
    });
  });
});
