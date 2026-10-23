import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PayoutModerationService } from './payout-moderation.service';

const jwt = { verify: jest.fn() };
function makePrisma() {
  const prisma: any = {
    payoutClaim: { findUnique: jest.fn(), update: jest.fn() },
    ledgerEntry: { create: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (cb: any) => cb(prisma));
  return prisma;
}
function build() {
  const prisma = makePrisma();
  return { prisma, svc: new PayoutModerationService(jwt as any, prisma) };
}
beforeEach(() => jest.clearAllMocks());

it('confirm → CONFIRMED sans écriture ledger', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', userId: 'u1' });
  await svc.decide('TK', 'confirm');
  expect(prisma.payoutClaim.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CONFIRMED' }) }));
  expect(prisma.ledgerEntry.create).not.toHaveBeenCalled();
});

it('reject → CANCELLED + écriture ledger +montant (restaure)', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', status: 'SENT', amount: 50, currency: 'USD', userId: 'u1' });
  await svc.decide('TK', 'reject');
  expect(prisma.ledgerEntry.create).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ account: 'ORGANIZER', type: 'PAYOUT_ORGANIZER', amount: 50, currency: 'USD', userId: 'u1' }),
  }));
});

it('rejette un token déjà traité (status !== SENT)', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue({ id: 'c1', status: 'CONFIRMED', amount: 50, currency: 'USD', userId: 'u1' });
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(ConflictException);
});

it('rejette un mauvais type de token', async () => {
  const { svc } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'event-moderation', jti: 'J' });
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(ForbiddenException);
});

it('rejette un token invalide', async () => {
  const { svc } = build();
  jwt.verify.mockImplementation(() => { throw new Error('bad'); });
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(UnauthorizedException);
});

it('claim introuvable → NotFound', async () => {
  const { svc, prisma } = build();
  jwt.verify.mockReturnValue({ sub: 'c1', type: 'payout-claim', jti: 'J' });
  prisma.payoutClaim.findUnique.mockResolvedValue(null);
  await expect(svc.decide('TK', 'confirm')).rejects.toBeInstanceOf(NotFoundException);
});
