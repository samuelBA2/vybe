import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';

const mail = { sendPayoutClaimEmail: jest.fn() };
const jwt = { sign: jest.fn(() => 'TK') };
const config = { get: jest.fn(() => 'https://api.test') };

function build() {
  const prisma: any = {
    payoutClaim: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    ledgerEntry: { create: jest.fn(), aggregate: jest.fn() },
    user: { findUnique: jest.fn() },
    $executeRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  const svc = new PayoutsService(prisma, mail as any, jwt as any, config as any);
  return { svc, prisma };
}

const USER = { id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null };

// Helper : fixe le solde réel recalculé DANS la transaction.
function setBalance(prisma: any, amount: number) {
  prisma.ledgerEntry.aggregate.mockResolvedValue({ _sum: { amount } });
}

beforeEach(() => jest.clearAllMocks());

describe('PayoutsService.claimNet', () => {
  it('déduit le montant demandé et crée une réclamation SENT (partiel)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 50);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });

    const res = await svc.claimNet('u1', 'USD', '243810000000', 30);

    expect(prisma.payoutClaim.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: 30, currency: 'USD', status: 'SENT', userId: 'u1' }),
    }));
    expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ account: 'ORGANIZER', type: 'PAYOUT_ORGANIZER', amount: -30, currency: 'USD', userId: 'u1' }),
    }));
    expect(mail.sendPayoutClaimEmail).toHaveBeenCalledWith(expect.objectContaining({
      confirmUrl: expect.stringContaining('decision=confirm'),
      rejectUrl: expect.stringContaining('decision=reject'),
    }));
    expect(res).toMatchObject({ id: 'c1', status: 'SENT', amount: 30, currency: 'USD' });
  });

  it('accepte un montant égal au solde', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 30);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    await expect(svc.claimNet('u1', 'USD', 'x', 30)).resolves.toMatchObject({ amount: 30 });
    expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: -30 }) }));
  });

  it('refuse un montant supérieur au solde SANS aucune déduction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 10);
    prisma.user.findUnique.mockResolvedValue(USER);
    await expect(svc.claimNet('u1', 'USD', 'x', 20)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('refuse un montant sous le minimum (USD < 1) avant toute transaction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    await expect(svc.claimNet('u1', 'USD', 'x', 0.5)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('refuse une précision USD invalide (3 décimales)', async () => {
    const { svc } = build();
    await expect(svc.claimNet('u1', 'USD', 'x', 1.234)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuse un montant CDF non entier', async () => {
    const { svc } = build();
    await expect(svc.claimNet('u1', 'CDF', 'x', 2500.5)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuse un montant nul ou négatif', async () => {
    const { svc } = build();
    await expect(svc.claimNet('u1', 'USD', 'x', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.claimNet('u1', 'USD', 'x', -5)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepte le minimum exact (USD = 1)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 5);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 1, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    await expect(svc.claimNet('u1', 'USD', 'x', 1)).resolves.toMatchObject({ amount: 1 });
  });

  it('accepte le minimum exact CDF (2500)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 2500);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 2500, currency: 'CDF', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    await expect(svc.claimNet('u1', 'CDF', 'x', 2500)).resolves.toMatchObject({ amount: 2500 });
    expect(prisma.payoutClaim.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: 2500 }) }));
    expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ amount: -2500 }) }));
  });

  it('refuse un montant CDF sous le minimum (2499) avant toute transaction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    await expect(svc.claimNet('u1', 'CDF', 'x', 2499)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuse si le solde recalculé est nul : aucune écriture', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 0);
    prisma.user.findUnique.mockResolvedValue(USER);
    await expect(svc.claimNet('u1', 'USD', 'x', 1)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
  });

  it('renvoie la réclamation active existante sans re-déduire', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ id: 'c0', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', createdAt: new Date() });
    const res = await svc.claimNet('u1', 'USD', '243810000000', 10);
    expect(res.id).toBe('c0');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
  });

  it('course : réclamation créée entre-temps → relue sous verrou, pas de double déduction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'cX', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    setBalance(prisma, 50);
    prisma.user.findUnique.mockResolvedValue(USER);

    const res = await svc.claimNet('u1', 'USD', '243810000000', 50);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(res.id).toBe('cX');
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
  });

  it('échec du mail après commit : pas de 500, la vue est renvoyée', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    setBalance(prisma, 50);
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    mail.sendPayoutClaimEmail.mockRejectedValueOnce(new Error('smtp down'));

    const res = await svc.claimNet('u1', 'USD', 'x', 50);

    expect(prisma.ledgerEntry.create).toHaveBeenCalled();
    expect(res).toMatchObject({ id: 'c1', status: 'SENT', amount: 50 });
  });
});

describe('PayoutsService.resendClaim', () => {
  it('refuse le renvoi avant 60 s (cooldown)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', lastSentAt: new Date() });
    await expect(svc.resendClaim('u1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown : 59 s refusé', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', lastSentAt: new Date(Date.now() - 59_000) });
    await expect(svc.resendClaim('u1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
  });

  it('cooldown : 60 s accepté', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', lastSentAt: new Date(Date.now() - 60_000) });
    prisma.user.findUnique.mockResolvedValue(USER);
    await expect(svc.resendClaim('u1', 'c1')).resolves.toEqual({ ok: true });
  });

  it('mauvais propriétaire → NotFound', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'autre', status: 'SENT', lastSentAt: new Date(0) });
    await expect(svc.resendClaim('u1', 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('réclamation non SENT → BadRequest', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'CONFIRMED', lastSentAt: new Date(0) });
    await expect(svc.resendClaim('u1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
    expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
  });

  it('renvoie le mail après le cooldown et met à jour lastSentAt', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', lastSentAt: new Date(Date.now() - 120_000) });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null });
    const res = await svc.resendClaim('u1', 'c1');
    expect(mail.sendPayoutClaimEmail).toHaveBeenCalled();
    expect(prisma.payoutClaim.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c1' }, data: { lastSentAt: expect.any(Date) } }));
    expect(res).toEqual({ ok: true });
  });
});

describe('PayoutsService.getCurrentClaim', () => {
  const base = { amount: 10, currency: 'USD', mmoNumber: 'x', createdAt: new Date() };

  it('renvoie une réclamation SENT quel que soit son âge', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ ...base, id: 'c1', status: 'SENT', decidedAt: null, createdAt: new Date(Date.now() - 3600_000) });
    expect(await svc.getCurrentClaim('u1', 'USD')).toMatchObject({ id: 'c1', status: 'SENT' });
  });

  it('renvoie une réclamation CONFIRMED décidée récemment', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ ...base, id: 'c1', status: 'CONFIRMED', decidedAt: new Date() });
    expect(await svc.getCurrentClaim('u1', 'USD')).toMatchObject({ id: 'c1', status: 'CONFIRMED' });
  });

  it('renvoie null pour une réclamation terminée depuis plus de 15 min', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ ...base, id: 'c1', status: 'CONFIRMED', decidedAt: new Date(Date.now() - 16 * 60_000) });
    expect(await svc.getCurrentClaim('u1', 'USD')).toBeNull();
  });

  it('renvoie null quand aucune réclamation', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    expect(await svc.getCurrentClaim('u1', 'USD')).toBeNull();
  });
});
