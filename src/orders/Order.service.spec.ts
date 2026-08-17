import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './Order.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PLATFORM_FEE_RATE } from 'src/common/constants';

describe('OrderService', () => {
  let service: OrderService;
  // Le client de transaction (tx) passé au callback de $transaction.
  let tx: {
    $executeRaw: jest.Mock;
    order: { create: jest.Mock };
    ticket: { createMany: jest.Mock };
  };
  let prisma: {
    ticketCategory: { findUnique: jest.Mock };
    ticket: { findMany: jest.Mock}
    $transaction: jest.Mock;
  };
  let ticketAssets: { generateAssetsForOrder: jest.Mock };

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn(),
      order: { create: jest.fn() },
      ticket: { createMany: jest.fn() },
    };
    prisma = {
      ticketCategory: { findUnique: jest.fn() },
      ticket: { findMany: jest.fn().mockResolvedValue([]) },
      // $transaction exécute le callback en lui injectant notre faux tx.
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    ticketAssets = { generateAssetsForOrder: jest.fn().mockResolvedValue(undefined) };
    service = new OrderService(prisma as unknown as PrismaService, ticketAssets as any);
  });

  // Catégorie valide par défaut : PUBLISHED, deadline future, stock large.
  const category = (over: Partial<any> = {}) => ({
    id: 'cat-1',
    price: 100,
    maxPerOrder: 10,
    totalStock: 50,
    soldCount: 0,
    event: {
      status: 'PUBLISHED',
      purchaseDeadline: new Date(Date.now() + 3_600_000), // +1h
      endDate: new Date(Date.now() + 7_200_000), // +2h
    },
    ...over,
  });

  const dto = (over: Partial<any> = {}) => ({
    ticketCategoryId: 'cat-1',
    quantity: 2,
    ...over,
  });

  it('catégorie introuvable → 404, pas de transaction', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(null);
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('événement non PUBLISHED → 403, pas de transaction', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(
      category({ event: { status: 'PENDING_REVIEW', purchaseDeadline: new Date(Date.now() + 3_600_000), endDate: new Date() } }),
    );
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ventes clôturées (purchaseDeadline dépassée) → 403', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(
      category({ event: { status: 'PUBLISHED', purchaseDeadline: new Date(Date.now() - 1000), endDate: new Date() } }),
    );
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('quantité > maxPerOrder → 403', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(category({ maxPerOrder: 5 }));
    await expect(service.createOrder('user-1', dto({ quantity: 6 }))).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stock insuffisant (réservation atomique = 0 ligne) → 409, aucune commande créée', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(category());
    tx.$executeRaw.mockResolvedValue(0); // la garde SQL n'a touché aucune ligne
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
  });

  it('succès → réserve, crée la commande (montants + frais 15%) et N billets', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(category({ price: 100 }));
    tx.$executeRaw.mockResolvedValue(1); // réservation OK
    tx.order.create.mockResolvedValue({ id: 'order-1' });
    tx.ticket.createMany.mockResolvedValue({ count: 2 });
    // La réponse relit les billets (avec leurs URLs) après le commit.
    prisma.ticket.findMany.mockResolvedValue([
      { qrToken: 'q1', pdfUrl: null, ticketImageUrl: null },
      { qrToken: 'q2', pdfUrl: null, ticketImageUrl: null },
    ]);

    const res = await service.createOrder('user-1', dto({ quantity: 2 }));

    // Montants : totalAmount = 2×100 = 200 ; fee = 200×0.15 = 30 ; organizer = 170.
    expect(PLATFORM_FEE_RATE).toBe(0.15);
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          ticketCategoryId: 'cat-1',
          quantity: 2,
          unitPrice: 100,
          totalAmount: 200,
          platformFee: 30,
          organizerAmount: 170,
          paymentStatus: 'PAID',
        }),
      }),
    );

    // N billets, chacun rattaché à la commande avec un qrToken et l'expiry = fin d'événement.
    const createManyArg = tx.ticket.createMany.mock.calls[0][0];
    expect(createManyArg.data).toHaveLength(2);
    expect(createManyArg.data[0]).toEqual(
      expect.objectContaining({ orderId: 'order-1', ticketCategoryId: 'cat-1' }),
    );
    expect(createManyArg.data[0].qrToken).toEqual(expect.any(String));

    // Deux qrToken distincts (aléatoire cryptographique).
    expect(createManyArg.data[0].qrToken).not.toBe(createManyArg.data[1].qrToken);

    // Réponse : la commande + les qrToken générés.
    expect(res.order).toEqual({ id: 'order-1' });
    expect(res.tickets).toHaveLength(2);
    expect(res.tickets[0]).toHaveProperty('qrToken');
  });

  it('déclenche la génération des visuels en post-commit (best-effort)', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(category());
    tx.$executeRaw.mockResolvedValue(1);
    tx.order.create.mockResolvedValue({ id: 'order-42' });
    tx.ticket.createMany.mockResolvedValue({ count: 2 });
    prisma.ticket.findMany.mockResolvedValue([{ qrToken: 'q', pdfUrl: null, ticketImageUrl: null }]);

    await service.createOrder('user-1', dto());

    // La génération est appelée avec l'id de la commande, APRÈS le commit.
    expect(ticketAssets.generateAssetsForOrder).toHaveBeenCalledWith('order-42');
  });

  it("un échec de la génération ne fait pas échouer l'achat", async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue(category());
    tx.$executeRaw.mockResolvedValue(1);
    tx.order.create.mockResolvedValue({ id: 'order-99' });
    tx.ticket.createMany.mockResolvedValue({ count: 1 });
    prisma.ticket.findMany.mockResolvedValue([{ qrToken: 'q', pdfUrl: null, ticketImageUrl: null }]);
    ticketAssets.generateAssetsForOrder.mockRejectedValue(new Error('génération KO'));

    // L'achat aboutit malgré l'échec de la génération.
    const res = await service.createOrder('user-1', dto({ quantity: 1 }));
    expect(res.order).toEqual({ id: 'order-99' });
  });
});
