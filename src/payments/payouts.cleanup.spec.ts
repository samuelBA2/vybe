import { PayoutsCleanupService } from './payouts.cleanup';

describe('PayoutsCleanupService', () => {
  it('résout chaque Payout PENDING périmé (markStuck)', async () => {
    const prisma = {
      payout: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ payoutRef: 'r1' }, { payoutRef: 'r2' }]),
      },
    } as any;
    const payouts = {
      resolvePayout: jest
        .fn()
        .mockResolvedValue({ payoutRef: 'r1', status: 'REVIEW' }),
    } as any;
    const service = new PayoutsCleanupService(prisma, payouts);

    await service.reapStuckPayouts();

    expect(prisma.payout.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    expect(payouts.resolvePayout).toHaveBeenCalledTimes(2);
    expect(payouts.resolvePayout).toHaveBeenCalledWith('r1', {
      markStuck: true,
    });
  });
});
