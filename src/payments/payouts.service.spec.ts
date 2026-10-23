import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';

const earnings = { getSummary: jest.fn() };
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
    ledgerEntry: { create: jest.fn() },
    user: { findUnique: jest.fn() },
    $executeRaw: jest.fn(),
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  const svc = new PayoutsService(prisma, earnings as any, mail as any, jwt as any, config as any);
  return { svc, prisma };
}

const USER = { id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null };

beforeEach(() => jest.clearAllMocks());

describe('PayoutsService.claimNet', () => {
  it('déduit le solde et crée une réclamation SENT', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    earnings.getSummary.mockResolvedValue({ balances: [{ currency: 'USD', balance: 50 }] });
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', firstname: 'A', lastname: 'B', email: 'a@b.co', phone: null });
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: '243810000000', jti: 'J', createdAt: new Date() });

    const res = await svc.claimNet('u1', 'USD', '243810000000');

    expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ account: 'ORGANIZER', type: 'PAYOUT_ORGANIZER', amount: -50, currency: 'USD', userId: 'u1' }),
    }));
    expect(mail.sendPayoutClaimEmail).toHaveBeenCalledWith(expect.objectContaining({
      confirmUrl: expect.stringContaining('decision=confirm'),
      rejectUrl: expect.stringContaining('decision=reject'),
    }));
    expect(res).toMatchObject({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD' });
  });

  it('renvoie la réclamation active existante sans re-déduire', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ id: 'c0', status: 'SENT', amount: 30, currency: 'USD', mmoNumber: 'x', createdAt: new Date() });
    const res = await svc.claimNet('u1', 'USD', '243810000000');
    expect(res.id).toBe('c0');
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
  });

  it('refuse si aucun solde', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    earnings.getSummary.mockResolvedValue({ balances: [{ currency: 'USD', balance: 0 }] });
    await expect(svc.claimNet('u1', 'USD', '243810000000')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
  });

  it('course : réclamation créée entre-temps → relue sous verrou, pas de double déduction', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'cX', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    earnings.getSummary.mockResolvedValue({ balances: [{ currency: 'USD', balance: 50 }] });
    prisma.user.findUnique.mockResolvedValue(USER);

    const res = await svc.claimNet('u1', 'USD', '243810000000');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(res.id).toBe('cX');
    expect(prisma.payoutClaim.create).not.toHaveBeenCalled();
    expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
    expect(mail.sendPayoutClaimEmail).not.toHaveBeenCalled();
  });

  it('échec du mail après commit : pas de 500, la vue est renvoyée', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    earnings.getSummary.mockResolvedValue({ balances: [{ currency: 'USD', balance: 50 }] });
    prisma.user.findUnique.mockResolvedValue(USER);
    prisma.payoutClaim.create.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', createdAt: new Date() });
    mail.sendPayoutClaimEmail.mockRejectedValueOnce(new Error('smtp down'));

    const res = await svc.claimNet('u1', 'USD', 'x');

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
