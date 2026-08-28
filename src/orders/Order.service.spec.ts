import {
  BadRequestException,
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
    ticketCategory: { findMany: jest.Mock };
    ticket: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
      ticket: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      ticketCategory: { findMany: jest.fn() },
      ticket: { findMany: jest.fn().mockResolvedValue([]) },
      // $transaction exécute le callback en lui injectant notre faux tx.
      // Un throw du callback se propage (en vrai, Prisma annulerait la transaction).
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    service = new OrderService(prisma as unknown as PrismaService);
  });

  // Catégorie valide par défaut : PUBLISHED, deadline future, stock large.
  const category = (over: Partial<any> = {}) => ({
    id: 'cat-1',
    name: 'Standard',
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

  // Panier à une seule ligne par défaut.
  const dto = (items: any[] = [{ ticketCategoryId: 'cat-1', quantity: 2 }]) => ({ items });

  it('catégorie introuvable → 404, pas de transaction', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([]); // aucune catégorie ne matche
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('événement non PUBLISHED → 403, pas de transaction', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([
      category({ event: { status: 'PENDING_REVIEW', purchaseDeadline: new Date(Date.now() + 3_600_000), endDate: new Date() } }),
    ]);
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ventes clôturées (purchaseDeadline dépassée) → 403', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([
      category({ event: { status: 'PUBLISHED', purchaseDeadline: new Date(Date.now() - 1000), endDate: new Date() } }),
    ]);
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('quantité > maxPerOrder → 403', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category({ maxPerOrder: 5 })]);
    await expect(
      service.createOrder('user-1', dto([{ ticketCategoryId: 'cat-1', quantity: 6 }])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('catégorie en double dans le panier → 400, pas de transaction', async () => {
    await expect(
      service.createOrder('user-1', dto([
        { ticketCategoryId: 'cat-1', quantity: 1 },
        { ticketCategoryId: 'cat-1', quantity: 2 },
      ])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.ticketCategory.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stock insuffisant (réservation = 0 ligne) → 409, aucune commande créée', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);
    tx.$executeRaw.mockResolvedValue(0); // la garde SQL n'a touché aucune ligne
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
  });

  it("ATOMICITÉ : 2ᵉ catégorie épuisée → 409 nommant la catégorie, tout est annulé", async () => {
    const catA = category({ id: 'cat-1', name: 'Standard' });
    const catB = category({ id: 'cat-2', name: 'VIP' });
    prisma.ticketCategory.findMany.mockResolvedValue([catA, catB]);
    // 1ʳᵉ réservation OK, 2ᵉ épuisée.
    tx.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(
      service.createOrder('user-1', dto([
        { ticketCategoryId: 'cat-1', quantity: 1 },
        { ticketCategoryId: 'cat-2', quantity: 1 },
      ])),
    ).rejects.toThrow('Stock insuffisant : VIP');

    // La 1ʳᵉ commande a bien été tentée dans la transaction ; le throw sur la 2ᵉ
    // provoque (en réel) le rollback de TOUT le panier — aucune 2ᵉ commande créée.
    expect(tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('succès multi-catégories → une commande par ligne (montants + frais 15%) et les billets', async () => {
    const catA = category({ id: 'cat-1', name: 'Standard', price: 100 });
    const catB = category({ id: 'cat-2', name: 'VIP', price: 50 });
    prisma.ticketCategory.findMany.mockResolvedValue([catA, catB]);
    tx.order.create
      .mockResolvedValueOnce({ id: 'order-1' })
      .mockResolvedValueOnce({ id: 'order-2' });
    prisma.ticket.findMany.mockResolvedValue([
      { qrToken: 'q1' },
      { qrToken: 'q2' },
      { qrToken: 'q3' },
    ]);

    const res = await service.createOrder('user-1', dto([
      { ticketCategoryId: 'cat-1', quantity: 2 },
      { ticketCategoryId: 'cat-2', quantity: 1 },
    ]));

    expect(PLATFORM_FEE_RATE).toBe(0.15);
    // cat-1 : 2×100 = 200, fee 30, org 170.
    expect(tx.order.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-1', ticketCategoryId: 'cat-1', quantity: 2,
        totalAmount: 200, platformFee: 30, organizerAmount: 170, paymentStatus: 'PAID',
      }),
    }));
    // cat-2 : 1×50 = 50, fee 7.5, org 42.5.
    expect(tx.order.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        ticketCategoryId: 'cat-2', quantity: 1,
        totalAmount: 50, platformFee: 7.5, organizerAmount: 42.5,
      }),
    }));
    // Billets créés pour chaque ligne (2 puis 1).
    expect(tx.ticket.createMany).toHaveBeenCalledTimes(2);
    expect(tx.ticket.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(tx.ticket.createMany.mock.calls[1][0].data).toHaveLength(1);

    expect(res.orderIds).toEqual(['order-1', 'order-2']);
    expect(res.tickets).toHaveLength(3);
  });
});
