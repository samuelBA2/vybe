import { Test, TestingModule } from '@nestjs/testing';
import type { Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { googleLogin: jest.Mock };

  beforeEach(async () => {
    // AuthService dépend de tout le graphe (Prisma/Jwt/Sms/Otp) ; on le remplace
    // par un mock n'exposant que ce dont les tests du contrôleur ont besoin.
    authService = { googleLogin: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('POST /auth/google délègue à googleLogin et pose le refresh cookie', async () => {
    authService.googleLogin.mockResolvedValue({
      accessToken: 'acc',
      refreshToken: 'ref',
    });

    const cookie = jest.fn();
    const res = { cookie } as unknown as Response;
    const out = await controller.google({ idToken: 'tok' }, res);

    expect(authService.googleLogin).toHaveBeenCalledWith('tok');
    expect(cookie).toHaveBeenCalled(); // setRefreshCookie
    expect(out).toEqual({ accessToken: 'acc' });
  });
});
