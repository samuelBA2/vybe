import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { GiftService } from './Gift.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('GiftService', () => {
  let service: GiftService;
  let tx: { $executeRaw: jest.Mock; order: { create: jest.Mock }; ticket: { createMany: jest.Mock } };
  let prisma: {
    event: { findUnique: jest.Mock };
    ticketCategory: { findFirst: jest.Mock };
    ticket: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      order: { create: jest.fn().mockResolvedValue({ id: 'gift-order-1' }) },
      ticket: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      event: { findUnique: jest.fn() },
      ticketCategory: { findFirst: jest.fn() },
      ticket: { findMany: jest.fn().mockResolvedValue([{ id: 'tk-1' }, { id: 'tk-2' }]) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    service = new GiftService(prisma as unknown as PrismaService);
  });

  const event = (over: Partial<any> = {}) => ({
    id: 'ev-1',
    reference: 'VYBE-8JGBLV',
    createdById: 'owner',
    totalCapacity: null, // illimité par défaut
    endDate: new Date(Date.now() + 7_200_000),
    ...over,
  });
  const category = (over: Partial<any> = {}) => ({
    id: 'cat-1', eventId: 'ev-1', name: 'Standard', giftedCount: 0, totalStock: null, soldCount: 0, ...over,
  });
  const dto = (over: Partial<any> = {}) => ({ ticketCategoryId: 'cat-1', quantity: 2, ...over });

  it('événement introuvable → 404, pas de transaction', async () => {
    prisma.event.findUnique.mockResolvedValue(null);
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('non-créateur → 403, pas de transaction', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    await expect(service.emitGifts('intrus', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('forfait limité ≤ 50 → 403', async () => {
    prisma.event.findUnique.mockResolvedValue(event({ totalCapacity: 50 }));
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('forfait limité > 50 → autorisé', async () => {
    prisma.event.findUnique.mockResolvedValue(event({ totalCapacity: 51 }));
    prisma.ticketCategory.findFirst.mockResolvedValue(category({ totalStock: 51 }));
    const res = await service.emitGifts('owner', 'VYBE-8JGBLV', dto());
    expect(res.orderId).toBe('gift-order-1');
  });

  it('catégorie hors événement / introuvable → 404', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(null);
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cumul > 10 (pré-check) → 400', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(category({ giftedCount: 9 }));
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto({ quantity: 2 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('succès illimité → crée une Order GIFT (montants 0) + N tickets', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(category());
    const res = await service.emitGifts('owner', 'VYBE-8JGBLV', dto({ quantity: 2 }));
    expect(tx.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'owner', ticketCategoryId: 'cat-1', quantity: 2,
          unitPrice: 0, totalAmount: 0, platformFee: 0, organizerAmount: 0, paymentStatus: 'GIFT',
        }),
      }),
    );
    const ticketsArg = tx.ticket.createMany.mock.calls[0][0].data;
    expect(ticketsArg).toHaveLength(2);
    expect(res).toEqual({ orderId: 'gift-order-1', tickets: [{ id: 'tk-1' }, { id: 'tk-2' }] });
  });

  it('UPDATE gardé renvoie 0 (plafond/stock concurrent) → 409', async () => {
    prisma.event.findUnique.mockResolvedValue(event());
    prisma.ticketCategory.findFirst.mockResolvedValue(category({ totalStock: 100 }));
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.emitGifts('owner', 'VYBE-8JGBLV', dto())).rejects.toBeInstanceOf(ConflictException);
  });
});
