import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ReservationsService } from './reservations.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('ReservationsService', () => {
  let service: ReservationsService;
  let tx: { $executeRaw: jest.Mock; reservation: { create: jest.Mock } };
  let prisma: {
    ticketCategory: { findUnique: jest.Mock };
    reservation: { count: jest.Mock };
    $transaction: jest.Mock;
  };

  const baseCategory = {
    id: 'cat1',
    name: 'Entrée',
    price: 10,
    reservationEnabled: true,
    event: {
      id: 'ev1',
      reference: 'VYBE-X',
      status: 'PUBLISHED',
      priceCurrency: 'USD',
      endDate: new Date(Date.now() + 86400000),
      purchaseDeadline: new Date(Date.now() + 3600000),
    },
  };
  const dto = (o: any = {}) => ({
    categoryId: 'cat1',
    holderFirstName: 'A',
    holderLastName: 'B',
    holderPhone: '+243900000000',
    ...o,
  });

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      reservation: {
        create: jest.fn().mockResolvedValue({ id: 'r1', qrToken: 'qr-uuid' }),
      },
    };
    prisma = {
      ticketCategory: { findUnique: jest.fn().mockResolvedValue(baseCategory) },
      reservation: { count: jest.fn() },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    service = new ReservationsService(prisma as unknown as PrismaService);
  });

  it('crée une réservation : incrément atomique + ligne Reservation RESERVED', async () => {
    const res = await service.create('user1', dto());
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.reservation.create.mock.calls[0][0].data).toMatchObject({
      eventId: 'ev1',
      categoryId: 'cat1',
      userId: 'user1',
      status: 'RESERVED',
      resolution: 'PENDING',
      holderFirstName: 'A',
      holderLastName: 'B',
      holderPhone: '+243900000000',
    });
    expect(res).toMatchObject({
      reservationId: 'r1',
      reference: 'VYBE-X',
      qrToken: 'qr-uuid',
    });
  });

  it('rejette si la catégorie n’est pas réservable', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue({
      ...baseCategory,
      reservationEnabled: false,
    });
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejette (plafond atteint) si l’incrément conditionnel n’affecte aucune ligne', async () => {
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('rejette (déjà réservé) si la création viole l’index unique (P2002)', async () => {
    tx.reservation.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejette si l’événement n’est pas PUBLISHED', async () => {
    prisma.ticketCategory.findUnique.mockResolvedValue({
      ...baseCategory,
      event: { ...baseCategory.event, status: 'PENDING_REVIEW' },
    });
    await expect(service.create('user1', dto())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  describe('hasActiveReservation', () => {
    it.each([undefined, ''])(
      'rejette (400) sans appeler count si eventId = %p',
      async (eventId) => {
        await expect(
          service.hasActiveReservation('user1', eventId as any),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.reservation.count).not.toHaveBeenCalled();
      },
    );

    it('délègue au count avec eventId présent', async () => {
      prisma.reservation.count.mockResolvedValue(1);
      await expect(service.hasActiveReservation('user1', 'ev1')).resolves.toBe(
        true,
      );
      expect(prisma.reservation.count).toHaveBeenCalledWith({
        where: { userId: 'user1', eventId: 'ev1', status: 'RESERVED' },
      });
    });
  });
});
