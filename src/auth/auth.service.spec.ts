import { Test, TestingModule } from '@nestjs/testing';
import {
  UnauthorizedException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { SmsService } from 'src/sms/sms.service';
import { ConfigService } from '@nestjs/config';
import { OtpService } from 'src/otp/otp.service';
import { MAX_LOGIN_ATTEMPTS } from 'src/common/constants';
import { $Enums } from '@prisma/client';

jest.mock('bcrypt');

const mockedBcrypt = bcrypt as jest.Mocked<typeof bcrypt>;

// Fabrique un user de base ; surcharge à volonté par test.
const makeUser = (over: Partial<any> = {}) => ({
  id: 'user-1',
  email: 'jean@vybe.app',
  phone: null,
  hashedPassword: 'hash-en-base',
  role: 'USER',
  isValid: true,
  failedLoginAttempts: 0,
  loginLockLevel: 0,
  loginLockedUntil: null,
  ...over,
});

describe('AuthService', () => {
  let service: AuthService;
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock };
    usedToken: { findUnique: jest.Mock; create: jest.Mock };
    agent: { findUnique: jest.Mock; update: jest.Mock };
    $transaction: jest.Mock;
  };
  let jwt: { sign: jest.Mock; verify: jest.Mock };
  let otp: {
    sendLoginEmailOtp: jest.Mock;
    sendLoginPhoneOtp: jest.Mock;
    verifyOtp: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn() },
      usedToken: { findUnique: jest.fn(), create: jest.fn() },
      agent: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(),
    };
    jwt = { sign: jest.fn().mockReturnValue('signed-jwt'), verify: jest.fn() };
    otp = {
      sendLoginEmailOtp: jest.fn(),
      sendLoginPhoneOtp: jest.fn(),
      verifyOtp: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: SmsService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => 'test-secret' } },
        { provide: OtpService, useValue: otp },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    process.env.JWT_SECRET = 'test-secret';
    mockedBcrypt.hash.mockResolvedValue('nouveau-hash' as never);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── login ──────────────────────────────────────────────────────────────────

  describe('login', () => {
    it('bon mot de passe → renvoie les tokens et remet les compteurs à zéro', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ failedLoginAttempts: 3 }),
      );
      mockedBcrypt.compare.mockResolvedValue(true as never);
      prisma.user.update.mockResolvedValue({});

      const res = await service.login({
        identifier: 'jean@vybe.app',
        password: 'bonMotDePasse1@',
      });

      expect(res).toHaveProperty('accessToken');
      expect(res).toHaveProperty('refreshToken');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            failedLoginAttempts: 0,
            loginLockLevel: 0,
            loginLockedUntil: null,
          }),
        }),
      );
    });

    it('mauvais mot de passe sous le seuil → 401 et incrémente le compteur', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ failedLoginAttempts: 1 }),
      );
      mockedBcrypt.compare.mockResolvedValue(false as never);
      prisma.user.update.mockResolvedValue({});

      await expect(
        service.login({ identifier: 'jean@vybe.app', password: 'faux' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ failedLoginAttempts: 2 }),
        }),
      );
    });

    it('5e mauvais essai (palier 1) → verrou ~5 min, niveau 1, compteur remis à 0', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ failedLoginAttempts: MAX_LOGIN_ATTEMPTS - 1, loginLockLevel: 0 }),
      );
      mockedBcrypt.compare.mockResolvedValue(false as never);
      prisma.user.update.mockResolvedValue({});

      const before = Date.now();
      await expect(
        service.login({ identifier: 'jean@vybe.app', password: 'faux' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.loginLockLevel).toBe(1);
      expect(data.failedLoginAttempts).toBe(0);
      const ms = new Date(data.loginLockedUntil).getTime() - before;
      expect(ms).toBeGreaterThan(4 * 60 * 1000);
      expect(ms).toBeLessThan(6 * 60 * 1000);
    });

    it('palier 2 → verrou ~1 h', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ failedLoginAttempts: MAX_LOGIN_ATTEMPTS - 1, loginLockLevel: 1 }),
      );
      mockedBcrypt.compare.mockResolvedValue(false as never);
      prisma.user.update.mockResolvedValue({});

      const before = Date.now();
      await expect(
        service.login({ identifier: 'jean@vybe.app', password: 'faux' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.loginLockLevel).toBe(2);
      const ms = new Date(data.loginLockedUntil).getTime() - before;
      expect(ms).toBeGreaterThan(55 * 60 * 1000);
      expect(ms).toBeLessThan(65 * 60 * 1000);
    });

    it('palier 3 → verrou ~12 h', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ failedLoginAttempts: MAX_LOGIN_ATTEMPTS - 1, loginLockLevel: 2 }),
      );
      mockedBcrypt.compare.mockResolvedValue(false as never);
      prisma.user.update.mockResolvedValue({});

      const before = Date.now();
      await expect(
        service.login({ identifier: 'jean@vybe.app', password: 'faux' }),
      ).rejects.toBeInstanceOf(ForbiddenException);

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data.loginLockLevel).toBe(3);
      const ms = new Date(data.loginLockedUntil).getTime() - before;
      expect(ms).toBeGreaterThan(11 * 60 * 60 * 1000);
      expect(ms).toBeLessThan(13 * 60 * 60 * 1000);
    });

    it('verrou actif → 403 sans comparer le mot de passe', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ loginLockedUntil: new Date(Date.now() + 60_000) }),
      );

      await expect(
        service.login({ identifier: 'jean@vybe.app', password: 'peu-importe' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockedBcrypt.compare).not.toHaveBeenCalled();
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('identifiant inexistant → 401 générique, aucun update', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      mockedBcrypt.compare.mockResolvedValue(false as never);

      await expect(
        service.login({ identifier: 'inconnu@vybe.app', password: 'x' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('compte sans hashedPassword → 401 générique, pas de crash', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ hashedPassword: null }),
      );

      await expect(
        service.login({ identifier: 'jean@vybe.app', password: 'x' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ─── forgotPassword ───────────────────────────────────────────────────────────

  describe('forgotPassword', () => {
    it('compte existant (email) → envoie OTP et renvoie un token', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUser());
      otp.sendLoginEmailOtp.mockResolvedValue(undefined);

      const res = await service.forgotPassword({ identifier: 'jean@vybe.app' });

      expect(otp.sendLoginEmailOtp).toHaveBeenCalledWith('jean@vybe.app');
      expect(res).toHaveProperty('token');
    });

    it('compte inexistant → même réponse, aucun envoi (anti-énumération)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const res = await service.forgotPassword({ identifier: 'inconnu@vybe.app' });

      expect(otp.sendLoginEmailOtp).not.toHaveBeenCalled();
      expect(res).toHaveProperty('token');
    });

    it('verrou actif → 403, aucun envoi', async () => {
      prisma.user.findUnique.mockResolvedValue(
        makeUser({ loginLockedUntil: new Date(Date.now() + 60_000) }),
      );

      await expect(
        service.forgotPassword({ identifier: 'jean@vybe.app' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(otp.sendLoginEmailOtp).not.toHaveBeenCalled();
    });
  });

  // ─── resetPassword ────────────────────────────────────────────────────────────

  describe('resetPassword', () => {
    const validPayload = {
      identifier: 'jean@vybe.app',
      purpose: 'password-reset',
      jti: 'jti-1',
    };
    const dto = {
      otp: '123456',
      newPassword: 'Nouveau1@',
      confirmPassword: 'Nouveau1@',
    };

    it('token invalide → exception', async () => {
      jwt.verify.mockImplementation(() => {
        throw new Error('bad');
      });
      await expect(service.resetPassword(dto, 'bad-token')).rejects.toThrow();
    });

    it('jti déjà utilisé → exception (anti-rejeu)', async () => {
      jwt.verify.mockReturnValue(validPayload);
      prisma.usedToken.findUnique.mockResolvedValue({ jti: 'jti-1' });

      await expect(service.resetPassword(dto, 'token')).rejects.toThrow();
      expect(otp.verifyOtp).not.toHaveBeenCalled();
    });

    it('OTP faux → propage l’exception de verifyOtp', async () => {
      jwt.verify.mockReturnValue(validPayload);
      prisma.usedToken.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(makeUser());
      otp.verifyOtp.mockRejectedValue(new BadRequestException('Code OTP invalide'));

      await expect(service.resetPassword(dto, 'token')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('succès → met à jour le hash et remet les compteurs à zéro dans une transaction', async () => {
      jwt.verify.mockReturnValue(validPayload);
      prisma.usedToken.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(makeUser());
      otp.verifyOtp.mockResolvedValue(undefined);
      mockedBcrypt.compare.mockResolvedValue(false as never); // ≠ ancien
      prisma.$transaction.mockResolvedValue([{}, {}]);

      const res = await service.resetPassword(dto, 'token');

      expect(mockedBcrypt.hash).toHaveBeenCalledWith('Nouveau1@', expect.any(Number));
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(res).toHaveProperty('message');
    });
  });

  // ─── loginAgent (connexion « en tant qu'agent ») ──────────────────────────────

  describe('loginAgent', () => {
    // endDate largement dans le futur par défaut (événement encore en cours).
    const makeAgent = (over: Partial<any> = {}) => ({
      id: 'agent-1',
      firstname: 'Ada',
      lastname: 'Lovelace',
      hashCode: 'peu-importe',
      active: true,
      usedAt: null,
      eventId: 'event-1',
      event: {
        endDate: new Date(Date.now() + 60 * 60 * 1000), // +1 h
        status: $Enums.EventStatus.PUBLISHED,
      },
      ...over,
    });

    it('code valide + agent actif (1re connexion) → émet un token et pose usedAt', async () => {
      prisma.agent.findUnique.mockResolvedValue(makeAgent());
      prisma.agent.update.mockResolvedValue({});

      const res = await service.loginAgent({ code: 'AG-ABCD2345' });

      // usedAt horodaté, uniquement à la première connexion.
      expect(prisma.agent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'agent-1' },
          data: expect.objectContaining({ usedAt: expect.any(Date) }),
        }),
      );
      // Token émis avec le périmètre événement (role AGENT + eventId).
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          sub: 'agent-1',
          role: 'AGENT',
          agentId: 'agent-1',
          eventId: 'event-1',
          type: 'access',
        }),
        // expiry dynamique : secondes restantes jusqu'à Event.endDate (> 0).
        expect.objectContaining({ expiresIn: expect.any(Number) }),
      );
      expect(jwt.sign.mock.calls[0][1].expiresIn).toBeGreaterThan(0);
      expect(res).toBeTruthy();
    });

    it('événement terminé (endDate passée) → 401, aucun token, aucun usedAt', async () => {
      prisma.agent.findUnique.mockResolvedValue(
        makeAgent({ event: { endDate: new Date(Date.now() - 1000), status: $Enums.EventStatus.PUBLISHED } }),
      );

      await expect(
        service.loginAgent({ code: 'AG-ABCD2345' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('événement non publié (status ≠ PUBLISHED) → 401, aucun token, aucun usedAt', async () => {
      prisma.agent.findUnique.mockResolvedValue(
        makeAgent({ event: { endDate: new Date(Date.now() + 60 * 60 * 1000), status: $Enums.EventStatus.CANCELLED } }),
      );

      await expect(
        service.loginAgent({ code: 'AG-ABCD2345' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('agent révoqué (active=false) → 401, aucun token, aucun usedAt', async () => {
      prisma.agent.findUnique.mockResolvedValue(makeAgent({ active: false }));

      await expect(
        service.loginAgent({ code: 'AG-ABCD2345' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('code inconnu → 401, aucun update', async () => {
      prisma.agent.findUnique.mockResolvedValue(null);

      await expect(
        service.loginAgent({ code: 'AG-ZZZZ2345' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(jwt.sign).not.toHaveBeenCalled();
    });

    it('connexion suivante (usedAt déjà posé) → ne réécrit pas usedAt, émet quand même un token', async () => {
      const firstLogin = new Date('2026-01-01T10:00:00Z');
      prisma.agent.findUnique.mockResolvedValue(makeAgent({ usedAt: firstLogin }));

      const res = await service.loginAgent({ code: 'AG-ABCD2345' });

      expect(prisma.agent.update).not.toHaveBeenCalled();
      expect(jwt.sign).toHaveBeenCalled();
      expect(res).toBeTruthy();
    });
  });
});
