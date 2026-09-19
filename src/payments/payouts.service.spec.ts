import { PayoutsService } from './payouts.service';
import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';

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
        findFirst: jest.fn(),
        findMany: jest.fn(),
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
      verifyWebhookSignature: jest.fn().mockReturnValue(true),
    };
    otp = { sendPayoutEmailOtp: jest.fn(), sendPayoutPhoneOtp: jest.fn(), verifyOtp: jest.fn() };
    jwt = {
      sign: jest.fn().mockReturnValue('temp.jwt'),
      verify: jest.fn().mockReturnValue({
        sub: 'org-1', type: 'payout', currency: 'USD', amount: 50, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD',
      }),
    };
    // getWithdrawable(userId, currency) → { currency, withdrawable }.
    earnings = { getWithdrawable: jest.fn().mockResolvedValue({ currency: 'USD', withdrawable: 100 }) };

    service = new PayoutsService(prisma, provider, otp, jwt, earnings);
  });

  describe('requestPayout', () => {
    it('valide, envoie OTP, renvoie tempToken + devise + montant', async () => {
      const res = await service.requestPayout('org-1', {
        currency: 'USD', amount: 50, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD',
      });
      expect(otp.sendPayoutEmailOtp).toHaveBeenCalledWith('a@b.co');
      expect(earnings.getWithdrawable).toHaveBeenCalledWith('org-1', 'USD');
      expect(res).toEqual({ tempToken: 'temp.jwt', currency: 'USD', amount: 50 });
      // Le token JWT porte la devise + le montant.
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'payout', currency: 'USD', amount: 50 }),
        expect.anything(),
      );
    });

    it('refuse un montant > solde retirable', async () => {
      await expect(
        service.requestPayout('org-1', { currency: 'USD', amount: 500, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' }),
      ).rejects.toThrow();
    });

    it('all:true retire tout le solde maturé de la devise', async () => {
      const res = await service.requestPayout('org-1', { currency: 'USD', all: true, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' });
      expect(res.amount).toBe(100);
    });

    it('refuse un opérateur ne supportant pas la devise demandée', async () => {
      provider.getOperators.mockResolvedValue([
        { code: 'VODACOM_MPESA_COD', name: 'Vodacom', available: true, currencies: ['CDF'] },
      ]);
      await expect(
        service.requestPayout('org-1', { currency: 'USD', amount: 50, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('CDF : montant arrondi à l\'entier, retrait dans la devise choisie', async () => {
      // Bornes CDF (payoutBounds) = bornes USD × taux figé = [11250, 4500000].
      earnings.getWithdrawable.mockResolvedValue({ currency: 'CDF', withdrawable: 250000 });
      const res = await service.requestPayout('org-1', { currency: 'CDF', amount: 150000.7, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' });
      expect(earnings.getWithdrawable).toHaveBeenCalledWith('org-1', 'CDF');
      expect(res).toEqual({ tempToken: 'temp.jwt', currency: 'CDF', amount: 150001 });
    });

    it('CDF : montant dans les bornes CDF (250 000, ∈ [11250, 4500000]) n\'est PAS rejeté pour cause de borne', async () => {
      earnings.getWithdrawable.mockResolvedValue({ currency: 'CDF', withdrawable: 300000 });
      const res = await service.requestPayout('org-1', { currency: 'CDF', amount: 250000, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' });
      expect(res.amount).toBe(250000);
    });

    it('CDF : refuse un montant > borne max CDF (5 000 000), message avec la devise', async () => {
      earnings.getWithdrawable.mockResolvedValue({ currency: 'CDF', withdrawable: 10000000 });
      await expect(
        service.requestPayout('org-1', { currency: 'CDF', amount: 5000000, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' }),
      ).rejects.toThrow('CDF');
    });

    it('CDF : refuse un montant < borne min CDF (10 000)', async () => {
      earnings.getWithdrawable.mockResolvedValue({ currency: 'CDF', withdrawable: 300000 });
      await expect(
        service.requestPayout('org-1', { currency: 'CDF', amount: 10000, phoneNumber: '243812345678', operator: 'VODACOM_MPESA_COD' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('verifyPayout', () => {
    it('débite le ledger (négatif, dans la devise) + crée Payout PENDING + initPayout', async () => {
      const res = await service.verifyPayout('org-1', '123456', 'temp.jwt');
      const ledgerArg = prisma.ledgerEntry.create.mock.calls[0][0].data;
      expect(ledgerArg.type).toBe('PAYOUT_ORGANIZER');
      expect(ledgerArg.amount).toBe(-50);
      expect(ledgerArg.currency).toBe('USD');
      expect(ledgerArg.payoutId).toBe('p1');
      // Payout créé avec devise + montant.
      const payoutArg = prisma.payout.create.mock.calls[0][0].data;
      expect(payoutArg.currency).toBe('USD');
      expect(payoutArg.amount).toBe(50);
      // initPayout dans la devise du retrait.
      expect(provider.initPayout).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 50, currency: 'USD' }),
      );
      expect(res).toEqual({ payoutRef: expect.any(String), status: 'PENDING', currency: 'USD', amount: 50 });
    });

    it('échec init → reversal (positif, même devise) + Payout FAILED', async () => {
      provider.initPayout.mockResolvedValue({ payoutRef: 'p1', status: 'DECLINED' });
      const res = await service.verifyPayout('org-1', '123456', 'temp.jwt');
      const reversal = prisma.ledgerEntry.create.mock.calls.find(
        (c: any[]) => c[0].data.type === 'PAYOUT_REVERSAL',
      );
      expect(reversal[0].data.amount).toBe(50);
      expect(reversal[0].data.currency).toBe('USD');
      expect(res.status).toBe('FAILED');
      expect(res.currency).toBe('USD');
      expect(res.amount).toBe(50);
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
        currency: 'USD',
        amount: 50,
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
        currency: 'USD',
        amount: 50,
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
      prisma.payout.findUnique.mockResolvedValue({ id: 'p1', payoutRef: 'ref', userId: 'org-1', currency: 'USD', amount: 50, status: 'PENDING' });
      provider.checkPayoutStatus.mockResolvedValue({ status: 'APPROVED' });
      const res = await service.resolvePayout('ref');
      expect(res.status).toBe('COMPLETED');
    });

    it('DECLINED → FAILED + reversal (une seule fois, même devise)', async () => {
      prisma.payout.findUnique.mockResolvedValue({ id: 'p1', payoutRef: 'ref', userId: 'org-1', currency: 'CDF', amount: 112500, status: 'PENDING' });
      provider.checkPayoutStatus.mockResolvedValue({ status: 'DECLINED' });
      const res = await service.resolvePayout('ref');
      expect(res.status).toBe('FAILED');
      const reversal = prisma.ledgerEntry.create.mock.calls.find(
        (c: any[]) => c[0].data.type === 'PAYOUT_REVERSAL',
      );
      expect(reversal).toBeTruthy();
      expect(reversal[0].data.amount).toBe(112500);
      expect(reversal[0].data.currency).toBe('CDF');
    });

    it('DECLINED → reverse() prend le verrou advisory par user avant d\'écrire la reversal', async () => {
      prisma.payout.findUnique.mockResolvedValue({ id: 'p1', payoutRef: 'ref', userId: 'org-1', currency: 'USD', amount: 50, status: 'PENDING' });
      provider.checkPayoutStatus.mockResolvedValue({ status: 'DECLINED' });
      await service.resolvePayout('ref');
      expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        expect.anything(),
      );
    });
  });

  describe('handlePayoutWebhook', () => {
    it('signature invalide → 401, sans résolution (resolvePayout non appelé)', async () => {
      provider.verifyWebhookSignature.mockReturnValue(false);
      const resolveSpy = jest.spyOn(service, 'resolvePayout');

      await expect(
        service.handlePayoutWebhook('{"payoutId":"ref"}', {}),
      ).rejects.toThrow(UnauthorizedException);
      expect(resolveSpy).not.toHaveBeenCalled();
    });

    it('signature valide → délègue à resolvePayout(payoutId)', async () => {
      const resolveSpy = jest
        .spyOn(service, 'resolvePayout')
        .mockResolvedValue({ payoutRef: 'ref', status: 'COMPLETED' });

      const res = await service.handlePayoutWebhook(
        '{"payoutId":"ref"}',
        { 'x-sig': 'ok' },
      );

      expect(resolveSpy).toHaveBeenCalledWith('ref');
      expect(res).toEqual({ payoutRef: 'ref', status: 'COMPLETED' });
    });

    it('corps illisible → BadRequestException', async () => {
      await expect(
        service.handlePayoutWebhook('pas-du-json', {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('payoutId absent → BadRequestException', async () => {
      await expect(
        service.handlePayoutWebhook('{}', {}),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('lecture', () => {
    it('getPayoutStatus scope strict userId (404 neutre sinon)', async () => {
      prisma.payout.findFirst = jest.fn().mockResolvedValue(null);
      await expect(service.getPayoutStatus('org-1', 'ref')).rejects.toThrow();
    });

    it('getPayoutStatus renvoie le statut quand trouvé (currency + amount, scope userId)', async () => {
      prisma.payout.findFirst = jest.fn().mockResolvedValue({
        payoutRef: 'ref', status: 'PENDING', currency: 'USD', amount: 50,
      });
      const res = await service.getPayoutStatus('org-1', 'ref');
      expect(prisma.payout.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { payoutRef: 'ref', userId: 'org-1' },
        select: expect.objectContaining({ currency: true, amount: true }),
      }));
      expect(res.status).toBe('PENDING');
    });

    it('listPayouts trie createdAt desc, keyset paginé (currency + amount, nextCursor si page suivante)', async () => {
      const rows = [
        { payoutRef: 'p3', currency: 'USD', amount: 10, operator: 'VODACOM_MPESA_COD', destination: '243812345678', status: 'COMPLETED', createdAt: new Date('2026-09-03T10:00:00Z') },
        { payoutRef: 'p2', currency: 'CDF', amount: 45000, operator: 'VODACOM_MPESA_COD', destination: '243812345678', status: 'COMPLETED', createdAt: new Date('2026-09-02T10:00:00Z') },
        { payoutRef: 'p1', currency: 'USD', amount: 30, operator: 'VODACOM_MPESA_COD', destination: '243812345678', status: 'PENDING', createdAt: new Date('2026-09-01T10:00:00Z') },
      ];
      prisma.payout.findMany.mockResolvedValue(rows); // limit=2 → 3 lignes = page suivante

      const res = await service.listPayouts('org-1', 2, null);

      expect(prisma.payout.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'org-1' },
        orderBy: [{ createdAt: 'desc' }, { payoutRef: 'desc' }],
        take: 3,
        select: expect.objectContaining({ currency: true, amount: true }),
      }));
      expect(res.items).toHaveLength(2);
      expect(res.nextCursor).not.toBeNull();
    });

    it('listPayouts applique le curseur keyset (createdAt/payoutRef) quand fourni', async () => {
      prisma.payout.findMany.mockResolvedValue([]);
      await service.listPayouts('org-1', 20, { v: '2026-09-02T10:00:00.000Z', id: 'p2' });
      const arg = prisma.payout.findMany.mock.calls[0][0];
      expect(arg.where).toEqual(expect.objectContaining({
        userId: 'org-1',
        OR: [
          { createdAt: { lt: new Date('2026-09-02T10:00:00.000Z') } },
          { createdAt: new Date('2026-09-02T10:00:00.000Z'), payoutRef: { lt: 'p2' } },
        ],
      }));
    });
  });
});
