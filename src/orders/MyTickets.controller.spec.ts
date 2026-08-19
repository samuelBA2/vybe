import { Test } from '@nestjs/testing';
import { MyTicketsController } from './MyTickets.controller';
import { MyTicketsService } from './MyTickets.service';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';

describe('MyTicketsController', () => {
  let controller: MyTicketsController;
  const svc = { getMyTickets: jest.fn().mockResolvedValue({ upcoming: [], past: [] }) };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [MyTicketsController],
      providers: [{ provide: MyTicketsService, useValue: svc }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get(MyTicketsController);
  });

  it('délègue à getMyTickets avec req.user.sub', async () => {
    const res = await controller.myTickets({ user: { sub: 'user-1' } } as any);
    expect(svc.getMyTickets).toHaveBeenCalledWith('user-1');
    expect(res).toEqual({ upcoming: [], past: [] });
  });
});
