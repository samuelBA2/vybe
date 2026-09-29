import { PaymentsCleanupService } from './payments.cleanup';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentsService } from './payments.service';

describe('PaymentsCleanupService', () => {
  let service: PaymentsCleanupService;
  let prisma: { order: { findMany: jest.Mock } };
  let payments: { resolvePayment: jest.Mock; expireUnresolved: jest.Mock };

  beforeEach(() => {
    prisma = { order: { findMany: jest.fn().mockResolvedValue([]) } };
    payments = {
      resolvePayment: jest
        .fn()
        .mockResolvedValue({ paymentRef: 'r', status: 'EXPIRED' }),
      expireUnresolved: jest.fn().mockResolvedValue(undefined),
    };
    service = new PaymentsCleanupService(
      prisma as unknown as PrismaService,
      payments as unknown as PaymentsService,
    );
  });

  it('sélectionne les paymentRef PENDING au-delà du TTL (distinct) et appelle resolvePayment(expireStale)', async () => {
    prisma.order.findMany.mockResolvedValue([
      { paymentRef: 'r1' },
      { paymentRef: 'r2' },
    ]);

    await service.reapExpiredPayments();

    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ paymentStatus: 'PENDING' }),
      distinct: ['paymentRef'],
    }));
    // cutoff = maintenant - TTL : la borne haute createdAt doit être dans le passé.
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.createdAt.lt).toBeInstanceOf(Date);
    expect(where.createdAt.lt.getTime()).toBeLessThan(Date.now());

    expect(payments.resolvePayment).toHaveBeenCalledTimes(2);
    expect(payments.resolvePayment).toHaveBeenCalledWith('r1', { expireStale: true });
    expect(payments.resolvePayment).toHaveBeenCalledWith('r2', { expireStale: true });
  });

  it("une erreur sur un paymentRef n'interrompt pas les autres", async () => {
    prisma.order.findMany.mockResolvedValue([
      { paymentRef: 'r1' },
      { paymentRef: 'r2' },
    ]);
    payments.resolvePayment.mockRejectedValueOnce(new Error('boom'));

    await expect(service.reapExpiredPayments()).resolves.not.toThrow();
    expect(payments.resolvePayment).toHaveBeenCalledTimes(2);
  });

  it('aucune commande expirée → resolvePayment jamais appelé', async () => {
    prisma.order.findMany.mockResolvedValue([]);
    await service.reapExpiredPayments();
    expect(payments.resolvePayment).not.toHaveBeenCalled();
  });

  it('V1 : statut toujours introuvable au-delà de 24 h → expireUnresolved', async () => {
    const old = new Date(Date.now() - 25 * 3_600_000);
    prisma.order.findMany.mockResolvedValue([
      { paymentRef: 'r1', createdAt: old },
    ]);
    payments.resolvePayment.mockRejectedValue(new Error('ARAKA 500'));

    await service.reapExpiredPayments();

    expect(payments.expireUnresolved).toHaveBeenCalledWith('r1');
  });

  it('V1 : statut introuvable depuis moins de 24 h → on attend (pas d’expiration forcée)', async () => {
    const recent = new Date(Date.now() - 2 * 3_600_000);
    prisma.order.findMany.mockResolvedValue([
      { paymentRef: 'r1', createdAt: recent },
    ]);
    payments.resolvePayment.mockRejectedValue(new Error('ARAKA 500'));

    await service.reapExpiredPayments();

    expect(payments.expireUnresolved).not.toHaveBeenCalled();
  });
});
