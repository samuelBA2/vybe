import { BadRequestException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';

const earnings = { getSummary: jest.fn() };
const mail = { sendPayoutClaimEmail: jest.fn() };
const jwt = { sign: jest.fn(() => 'TK') };
const config = { get: jest.fn(() => 'https://api.test') };

function makePrisma() {
  return {
    payoutClaim: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    ledgerEntry: { create: jest.fn() },
    user: { findUnique: jest.fn() },
    $transaction: jest.fn(async (cb: any) => cb(txOf(prismaRef.current))),
  } as any;
}
const prismaRef: { current: any } = { current: null };
function txOf(p: any) { return p; }

function build() {
  const prisma = makePrisma();
  prismaRef.current = prisma;
  const svc = new PayoutsService(prisma, earnings as any, mail as any, jwt as any, config as any);
  return { svc, prisma };
}

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
  });
});

describe('PayoutsService.resendClaim', () => {
  it('refuse le renvoi avant 60 s (cooldown)', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', userId: 'u1', status: 'SENT', amount: 50, currency: 'USD', mmoNumber: 'x', jti: 'J', lastSentAt: new Date() });
    await expect(svc.resendClaim('u1', 'c1')).rejects.toBeInstanceOf(BadRequestException);
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
  it('renvoie la plus récente réclamation de la devise', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue({ id: 'c1', status: 'CONFIRMED', amount: 10, currency: 'USD', mmoNumber: 'x', createdAt: new Date() });
    const res = await svc.getCurrentClaim('u1', 'USD');
    expect(res).toMatchObject({ id: 'c1', status: 'CONFIRMED' });
  });

  it('renvoie null quand aucune réclamation', async () => {
    const { svc, prisma } = build();
    prisma.payoutClaim.findFirst.mockResolvedValue(null);
    expect(await svc.getCurrentClaim('u1', 'USD')).toBeNull();
  });
});
