import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventModerationService } from './event-moderation.service';

describe('EventModerationService', () => {
  let service: EventModerationService;
  let jwt: any;
  let prisma: any;
  let mail: any;

  beforeEach(() => {
    jwt = {
      sign: jest.fn().mockReturnValue('signed.jwt'),
      verify: jest.fn(),
    };
    prisma = {
      usedToken: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      event: { findUnique: jest.fn(), update: jest.fn() },
      notification: { create: jest.fn() },
      $transaction: jest.fn(async (cb) => cb(prisma)),
    };
    mail = { sendEventDecisionEmail: jest.fn().mockResolvedValue(undefined) };
    service = new EventModerationService(jwt, prisma, mail);
  });

  it('generateModerationToken signe un token typé', () => {
    const token = service.generateModerationToken('evt-1');
    expect(token).toBe('signed.jwt');
    const payload = jwt.sign.mock.calls[0][0];
    expect(payload.sub).toBe('evt-1');
    expect(payload.type).toBe('event-moderation');
    expect(payload.jti).toBeDefined();
  });

  it('refuse un token invalide', async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('bad');
    });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un token du mauvais type', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'login-verify', jti: 'j1' });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuse un jti déjà utilisé', async () => {
    jwt.verify.mockReturnValue({
      sub: 'evt-1',
      type: 'event-moderation',
      jti: 'j1',
    });
    prisma.usedToken.findUnique.mockResolvedValue({ jti: 'j1' });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      ConflictException,
    );
  });

  it('refuse si l’événement est introuvable', async () => {
    jwt.verify.mockReturnValue({
      sub: 'evt-1',
      type: 'event-moderation',
      jti: 'j1',
    });
    prisma.event.findUnique.mockResolvedValue(null);
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuse si l’événement n’est plus en attente', async () => {
    jwt.verify.mockReturnValue({
      sub: 'evt-1',
      type: 'event-moderation',
      jti: 'j1',
    });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PUBLISHED',
    });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      ConflictException,
    );
  });

  it('approuve : passe à PUBLISHED, consomme le jti, notifie le créateur', async () => {
    jwt.verify.mockReturnValue({
      sub: 'evt-1',
      type: 'event-moderation',
      jti: 'j1',
    });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PENDING_REVIEW',
      title: 'Soirée',
      createdById: 'owner',
      createdBy: { email: 'u@x.com' },
    });
    const res = await service.moderate('x', 'approve');
    expect(prisma.event.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt-1' },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );
    expect(prisma.usedToken.create).toHaveBeenCalledWith({
      data: { jti: 'j1' },
    });
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner',
        type: 'EVENT_PUBLISHED',
        eventId: expect.any(String),
      }),
    });
    expect(mail.sendEventDecisionEmail).toHaveBeenCalledWith(
      'u@x.com',
      'Soirée',
      true,
    );
    expect(res.message).toContain('validé');
  });

  it('refuse (reject) : passe à REJECTED et notifie', async () => {
    jwt.verify.mockReturnValue({
      sub: 'evt-1',
      type: 'event-moderation',
      jti: 'j1',
    });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PENDING_REVIEW',
      title: 'Soirée',
      createdById: 'owner',
      createdBy: { email: 'u@x.com' },
    });
    await service.moderate('x', 'reject');
    expect(prisma.event.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED' }),
      }),
    );
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'owner',
        type: 'EVENT_REJECTED',
        eventId: expect.any(String),
      }),
    });
    expect(mail.sendEventDecisionEmail).toHaveBeenCalledWith(
      'u@x.com',
      'Soirée',
      false,
    );
  });

  it('n’envoie pas de mail si le créateur n’a pas d’email', async () => {
    jwt.verify.mockReturnValue({
      sub: 'evt-1',
      type: 'event-moderation',
      jti: 'j1',
    });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PENDING_REVIEW',
      title: 'Soirée',
      createdBy: { email: null },
    });
    await service.moderate('x', 'approve');
    expect(mail.sendEventDecisionEmail).not.toHaveBeenCalled();
  });
});
