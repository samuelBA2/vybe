import { NotificationsService } from './notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    notification: {
      create: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      notification: {
        create: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new NotificationsService(prisma as unknown as PrismaService);
  });

  it('create insère une notif pour le user', async () => {
    await service.create('u1', 'EVENT_SUBMITTED', 'T', 'B', 'e1');
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 'u1',
        type: 'EVENT_SUBMITTED',
        title: 'T',
        body: 'B',
        eventId: 'e1',
      },
    });
  });

  it('listForUser : tri createdAt desc, filtre userId, plafonné, projette le DTO', async () => {
    prisma.notification.findMany.mockResolvedValue([
      {
        id: 'n1',
        type: 'EVENT_PUBLISHED',
        title: 'T',
        body: 'B',
        eventId: 'e1',
        read: false,
        createdAt: new Date(0),
      },
    ]);
    const res = await service.listForUser('u1');
    const args = prisma.notification.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ userId: 'u1' });
    expect(args.orderBy).toEqual({ createdAt: 'desc' });
    expect(args.take).toBeGreaterThan(0);
    expect(res).toEqual([
      {
        id: 'n1',
        type: 'EVENT_PUBLISHED',
        title: 'T',
        body: 'B',
        eventId: 'e1',
        read: false,
        createdAt: new Date(0),
      },
    ]);
  });

  it('unreadCount : compte les non-lues du user', async () => {
    prisma.notification.count.mockResolvedValue(3);
    const res = await service.unreadCount('u1');
    expect(prisma.notification.count).toHaveBeenCalledWith({
      where: { userId: 'u1', read: false },
    });
    expect(res).toEqual({ count: 3 });
  });

  it('markRead : gardé par userId + read=false (ownership, idempotent)', async () => {
    const res = await service.markRead('u1', 'n1');
    expect(prisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', userId: 'u1', read: false },
      data: { read: true },
    });
    expect(res).toEqual({ ok: true });
  });
});
