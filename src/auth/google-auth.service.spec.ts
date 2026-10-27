import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAuthService } from './google-auth.service';

jest.mock('google-auth-library');

const mockVerifyIdToken = jest.fn();
(OAuth2Client as unknown as jest.Mock).mockImplementation(() => ({
  verifyIdToken: mockVerifyIdToken,
}));

describe('GoogleAuthService', () => {
  let service: GoogleAuthService;

  beforeEach(async () => {
    mockVerifyIdToken.mockReset();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GoogleAuthService,
        { provide: ConfigService, useValue: { get: () => 'client-id-test' } },
      ],
    }).compile();
    service = module.get(GoogleAuthService);
  });

  it('mappe un payload Google valide vers GoogleProfile', async () => {
    mockVerifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'g-123',
        email: 'jean@gmail.com',
        email_verified: true,
        given_name: 'Jean',
        family_name: 'Dupont',
        picture: 'http://img/p.png',
      }),
    });

    const profile = await service.verifyIdToken('token-ok');

    expect(profile).toEqual({
      googleId: 'g-123',
      email: 'jean@gmail.com',
      emailVerified: true,
      firstName: 'Jean',
      lastName: 'Dupont',
      picture: 'http://img/p.png',
    });
  });

  it('lève UnauthorizedException si verifyIdToken échoue', async () => {
    mockVerifyIdToken.mockRejectedValue(new Error('invalid'));
    await expect(service.verifyIdToken('bad')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('lève UnauthorizedException si le payload est incomplet', async () => {
    mockVerifyIdToken.mockResolvedValue({ getPayload: () => undefined });
    await expect(service.verifyIdToken('empty')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
