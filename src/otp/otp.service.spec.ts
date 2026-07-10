import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { OtpService } from './otp.service';
import { SmsService } from 'src/sms/sms.service';
import { MailService } from 'src/mail/mail.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('OtpService — stockage haché des OTP (audit M2)', () => {
  let service: OtpService;

  const txMock = {
    otpVerification: {
      updateMany: jest.fn(),
      create: jest.fn(),
    },
  };

  const prismaMock = {
    user: { findUnique: jest.fn() },
    otpVerification: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((fn: (tx: typeof txMock) => Promise<void>) =>
      fn(txMock),
    ),
  };

  const mailMock = { sendOtp: jest.fn(), sendAccountDeletionOtp: jest.fn() };
  const smsMock = { sendOtp: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OtpService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: MailService, useValue: mailMock },
        { provide: SmsService, useValue: smsMock },
      ],
    }).compile();

    service = module.get(OtpService);
  });

  it("stocke un hash bcrypt du code, jamais le code en clair envoyé par email", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.otpVerification.findFirst.mockResolvedValue(null);

    await service.sendEmailOtp('test@example.com');

    // Le code en clair est celui envoyé par email
    const sentOtp: string = mailMock.sendOtp.mock.calls[0][1];
    expect(sentOtp).toMatch(/^\d{6}$/);

    // Ce qui part en base ne doit pas être le code en clair, mais son hash bcrypt
    const stored: string = txMock.otpVerification.create.mock.calls[0][0].data.code;
    expect(stored).not.toBe(sentOtp);
    await expect(bcrypt.compare(sentOtp, stored)).resolves.toBe(true);
  });

  it('verifyOtp accepte le bon code comparé au hash stocké', async () => {
    const hash = await bcrypt.hash('123456', 10);
    prismaMock.otpVerification.findFirst
      // 1er appel : checkBlock → pas de blocage
      .mockResolvedValueOnce(null)
      // 2e appel : recherche de l'OTP actif
      .mockResolvedValueOnce({
        id: 'otp-1',
        identifier: 'test@example.com',
        code: hash,
        used: false,
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
      });

    await expect(
      service.verifyOtp('test@example.com', '123456'),
    ).resolves.toBeUndefined();

    expect(prismaMock.otpVerification.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { used: true },
    });
  });

  it('verifyOtp rejette un mauvais code et incrémente attempts', async () => {
    const hash = await bcrypt.hash('123456', 10);
    prismaMock.otpVerification.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'otp-1',
        identifier: 'test@example.com',
        code: hash,
        used: false,
        attempts: 0,
        expiresAt: new Date(Date.now() + 60000),
      });

    await expect(
      service.verifyOtp('test@example.com', '000000'),
    ).rejects.toThrow(BadRequestException);

    expect(prismaMock.otpVerification.update).toHaveBeenCalledWith({
      where: { id: 'otp-1' },
      data: { attempts: 1 },
    });
  });

  it("la génération d'OTP ne fait plus de recherche d'unicité en base (anti-pattern)", async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await service.sendEmailOtp('test@example.com');

    // Avant le fix, generateUniqueOtp appelait findFirst({ where: { code } })
    expect(prismaMock.otpVerification.findFirst).not.toHaveBeenCalled();
  });
});
