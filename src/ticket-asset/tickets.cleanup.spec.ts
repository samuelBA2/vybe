import { Logger } from '@nestjs/common';
import { TicketsCleanupService } from './tickets.cleanup';

function makePrisma(tickets: any[]) {
  return {
    ticket: {
      findMany: jest.fn().mockResolvedValue(tickets),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as any;
}
function makeCloudinary() {
  return { deleteAsset: jest.fn().mockResolvedValue({}) } as any;
}

describe('TicketsCleanupService.purgeExpired', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('aucun billet expiré → aucune suppression', async () => {
    const prisma = makePrisma([]);
    const cloudinary = makeCloudinary();
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    expect(prisma.ticket.delete).not.toHaveBeenCalled();
    expect(cloudinary.deleteAsset).not.toHaveBeenCalled();
  });

  it('billet avec PNG + PDF → supprime les deux médias (bons resource_type) puis la ligne', async () => {
    const prisma = makePrisma([
      {
        id: 't1',
        ticketImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/tickets/img1.png',
        pdfUrl: 'https://res.cloudinary.com/demo/raw/upload/v1/tickets/ticket-t1.pdf',
      },
    ]);
    const cloudinary = makeCloudinary();
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    expect(cloudinary.deleteAsset).toHaveBeenCalledWith('tickets/img1', 'image');
    expect(cloudinary.deleteAsset).toHaveBeenCalledWith('tickets/ticket-t1.pdf', 'raw');
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
  });

  it('billet sans médias (null) → supprime la ligne sans appeler Cloudinary', async () => {
    const prisma = makePrisma([{ id: 't2', ticketImageUrl: null, pdfUrl: null }]);
    const cloudinary = makeCloudinary();
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    expect(cloudinary.deleteAsset).not.toHaveBeenCalled();
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 't2' } });
  });

  it('échec Cloudinary sur un billet → loggé, la boucle continue', async () => {
    const prisma = makePrisma([
      { id: 't1', ticketImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/tickets/a.png', pdfUrl: null },
      { id: 't2', ticketImageUrl: null, pdfUrl: null },
    ]);
    const cloudinary = makeCloudinary();
    cloudinary.deleteAsset.mockRejectedValueOnce(new Error('Cloudinary down'));
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    // t1 échoue avant son delete, mais t2 est bien traité
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 't2' } });
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
