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

  // En prod, front (www.vybeplatform.app) et API (api.vybeplatform.app) sont
  // sur le même site : SameSite=Lax suffit, et la suppression doit reprendre
  // les mêmes attributs que la pose, sinon le navigateur garde le cookie.
  describe('cookie de refresh en production', () => {
    const previousEnv = process.env.NODE_ENV;
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });
    afterEach(() => {
      process.env.NODE_ENV = previousEnv;
    });

    const expectedOptions = {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/auth',
    };

    it('pose le cookie en SameSite=Lax + Secure', async () => {
      authService.googleLogin.mockResolvedValue({
        accessToken: 'acc',
        refreshToken: 'ref',
      });
      const cookie = jest.fn();
      await controller.google({ idToken: 'tok' }, {
        cookie,
      } as unknown as Response);

      expect(cookie).toHaveBeenCalledWith(
        'vybe_refresh',
        'ref',
        expect.objectContaining(expectedOptions),
      );
    });

    it('POST /auth/logout efface le cookie avec les mêmes attributs', () => {
      const clearCookie = jest.fn();
      controller.logout({ clearCookie } as unknown as Response);

      expect(clearCookie).toHaveBeenCalledWith(
        'vybe_refresh',
        expect.objectContaining(expectedOptions),
      );
    });
  });
});
