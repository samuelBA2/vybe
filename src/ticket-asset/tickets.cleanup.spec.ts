import { Logger } from '@nestjs/common';
import { TicketsCleanupService } from './tickets.cleanup';

function makePrisma(count: number) {
  return {
    ticket: {
      deleteMany: jest.fn().mockResolvedValue({ count }),
    },
  } as any;
}

describe('TicketsCleanupService.purgeExpired', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('supprime les lignes de billets expirés en une seule requête', async () => {
    const prisma = makePrisma(3);
    await new TicketsCleanupService(prisma).purgeExpired();

    expect(prisma.ticket.deleteMany).toHaveBeenCalledTimes(1);
    const { where } = prisma.ticket.deleteMany.mock.calls[0][0];
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    expect(Logger.prototype.log).toHaveBeenCalledWith('Purge de 3 billet(s) expiré(s).');
  });

  it('aucun billet expiré → pas de log', async () => {
    const prisma = makePrisma(0);
    await new TicketsCleanupService(prisma).purgeExpired();

    expect(prisma.ticket.deleteMany).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });
});
