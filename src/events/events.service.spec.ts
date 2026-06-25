import { BadRequestException } from '@nestjs/common';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';

function baseDto(overrides: Partial<CreateEventDto> = {}): CreateEventDto {
  return {
    title: 'Soirée',
    description: 'desc',
    startDate: '2030-01-01T20:00:00Z',
    endDate: '2030-01-01T23:00:00Z',
    location: 'Kinshasa',
    purchaseDeadline: '2030-01-01T18:00:00Z',
    category: 'CONCERT' as any,
    termsAccepted: true,
    media: [
      {
        url: 'https://cdn/a.png',
        fileKey: 'k',
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        mediaType: 'IMAGE' as any,
        isPoster: true,
      },
    ],
    ticketCategories: [
      { name: 'VIP', price: 100, ticketDesignUrl: 'https://cdn/vip.png' },
    ],
    ...overrides,
  };
}

describe('EventsService.createEvent', () => {
  let service: EventsService;
  let prisma: any;
  let mail: any;
  let moderation: any;

  beforeEach(() => {
    const createdEvent = {
      id: 'evt-1',
      title: 'Soirée',
      status: 'PENDING_REVIEW',
      createdById: 'user-1',
      createdBy: { id: 'user-1', email: 'u@x.com' },
    };
    prisma = {
      event: { create: jest.fn().mockResolvedValue(createdEvent) },
    };
    mail = { sendEventModerationEmail: jest.fn().mockResolvedValue(undefined) };
    moderation = { generateModerationToken: jest.fn().mockReturnValue('tok') };
    service = new EventsService(prisma, mail, moderation);
    process.env.API_BASE_URL = 'https://api.test';
    process.env.VYBE_TEAM_EMAIL = 'team@vybe.app';
  });

  it('refuse si startDate est dans le passé', async () => {
    await expect(
      service.createEvent(
        'user-1',
        baseDto({ startDate: '2000-01-01T20:00:00Z' }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse si endDate <= startDate', async () => {
    await expect(
      service.createEvent('user-1', baseDto({ endDate: '2030-01-01T19:00:00Z' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse si purchaseDeadline > startDate', async () => {
    await expect(
      service.createEvent(
        'user-1',
        baseDto({ purchaseDeadline: '2030-01-01T21:00:00Z' }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse si aucune affiche (isPoster) n’est présente', async () => {
    const dto = baseDto();
    dto.media[0].isPoster = false;
    await expect(service.createEvent('user-1', dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuse si plusieurs affiches sont marquées', async () => {
    const dto = baseDto();
    dto.media = [
      { ...dto.media[0], isPoster: true },
      { ...dto.media[0], fileKey: 'k2', isPoster: true },
    ];
    await expect(service.createEvent('user-1', dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('crée l’événement en PENDING_REVIEW et envoie le mail de modération', async () => {
    const res = await service.createEvent('user-1', baseDto());

    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.createdById).toBe('user-1');
    expect(arg.data.status).toBe('PENDING_REVIEW');
    expect(arg.data.mediaFiles.create).toHaveLength(1);
    expect(arg.data.ticketCategories.create).toHaveLength(1);

    expect(moderation.generateModerationToken).toHaveBeenCalledWith('evt-1');
    expect(mail.sendEventModerationEmail).toHaveBeenCalledTimes(1);
    const mailArg = mail.sendEventModerationEmail.mock.calls[0][0];
    expect(mailArg.to).toBe('team@vybe.app');
    expect(mailArg.approveUrl).toContain('decision=approve');
    expect(mailArg.rejectUrl).toContain('decision=reject');
    expect(mailArg.posterUrl).toBe('https://cdn/a.png');

    expect(res.eventId).toBe('evt-1');
    expect(res.status).toBe('PENDING_REVIEW');
    expect(res.message).toContain('validation');
  });
});
