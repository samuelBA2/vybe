import { Test } from '@nestjs/testing';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';

describe('NotificationsController', () => {
  let controller: NotificationsController;
  const svc = {
    listForUser: jest.fn().mockResolvedValue([{ id: 'n1' }]),
    unreadCount: jest.fn().mockResolvedValue({ count: 2 }),
    markRead: jest.fn().mockResolvedValue({ ok: true }),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [NotificationsController],
      providers: [{ provide: NotificationsService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(NotificationsController);
  });

  it('délègue à listForUser avec req.user.sub', async () => {
    const res = await controller.list({ user: { sub: 'user-1' } } as any);
    expect(svc.listForUser).toHaveBeenCalledWith('user-1');
    expect(res).toEqual([{ id: 'n1' }]);
  });

  it('délègue à unreadCount avec req.user.sub', async () => {
    const res = await controller.unreadCount({
      user: { sub: 'user-1' },
    } as any);
    expect(svc.unreadCount).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ count: 2 });
  });

  it('délègue à markRead avec req.user.sub et id', async () => {
    const res = await controller.markRead(
      { user: { sub: 'user-1' } } as any,
      'n1',
    );
    expect(svc.markRead).toHaveBeenCalledWith('user-1', 'n1');
    expect(res).toEqual({ ok: true });
  });
});
