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
    unlimitedStock: true,
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
  let notifications: any;

  beforeEach(() => {
    const createdEvent = {
      id: 'evt-1',
      title: 'Soirée',
      status: 'PENDING_REVIEW',
      createdById: 'user-1',
      createdBy: { id: 'user-1', email: 'u@x.com' },
    };
    prisma = {
      event: {
        create: jest.fn().mockResolvedValue(createdEvent),
        // generateUniqueReference() interroge findUnique jusqu'à obtenir une
        // référence libre ; null = aucune collision, la 1re tentative suffit.
        findUnique: jest.fn().mockResolvedValue(null),
      },
      // Les médias soumis sont marqués "attachés" pour échapper à la purge.
      uploadedAsset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    mail = { sendEventModerationEmail: jest.fn().mockResolvedValue(undefined) };
    moderation = { generateModerationToken: jest.fn().mockReturnValue('tok') };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    service = new EventsService(prisma, mail, moderation, notifications);
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

  it('refuse si purchaseDeadline > endDate', async () => {
    // endDate = 23:00 → une limite d'achat après la fin (lendemain 00:00) est refusée.
    await expect(
      service.createEvent(
        'user-1',
        baseDto({ purchaseDeadline: '2030-01-02T00:00:00Z' }),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('accepte purchaseDeadline entre startDate et endDate (vente pendant l’événement)', async () => {
    // 21:00 est après le début (20:00) mais avant la fin (23:00) : désormais autorisé.
    const res = await service.createEvent(
      'user-1',
      baseDto({ purchaseDeadline: '2030-01-01T21:00:00Z' }),
    );
    expect(res.eventId).toBe('evt-1');
  });

  it('accepte un événement sans affiche (0 affiche autorisée)', async () => {
    const dto = baseDto();
    dto.media[0].isPoster = false;

    const res = await service.createEvent('user-1', dto);

    // L'événement est bien créé…
    expect(prisma.event.create).toHaveBeenCalledTimes(1);
    expect(res.eventId).toBe('evt-1');
    // …et l'e-mail de modération part quand même, avec une affiche nulle
    // (et non un crash silencieux sur `poster.url`).
    expect(mail.sendEventModerationEmail).toHaveBeenCalledTimes(1);
    const mailArg = mail.sendEventModerationEmail.mock.calls[0][0];
    expect(mailArg.posterUrl).toBeNull();
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

  it('crée une notification de soumission au créateur (non bloquante)', async () => {
    await service.createEvent('user-1', baseDto());
    expect(notifications.create).toHaveBeenCalledWith(
      'user-1',
      'EVENT_SUBMITTED',
      expect.stringContaining('soumis'),
      expect.any(String),
      'evt-1',
    );
  });

  it("persiste priceCurrency du DTO dans l'événement créé", async () => {
    await service.createEvent('user-1', baseDto({ priceCurrency: 'CDF' as any }));

    const createArg = prisma.event.create.mock.calls[0][0];
    expect(createArg.data.priceCurrency).toBe('CDF');
  });

  describe('contrat carte (createdById + giftedCount)', () => {
    // Garde : findOne n'a aucun `select` restrictif (include complet), donc
    // createdById (scalaire Event) et giftedCount (scalaire TicketCategory)
    // sont exposés automatiquement à la carte "créateur" du front. Ce test
    // casse si un futur `select` venait à les omettre silencieusement.
    it('findOne renvoie createdById et giftedCount par catégorie', async () => {
      prisma.event.findUnique.mockResolvedValue({
        id: 'ev-1',
        reference: 'VYBE-AAA',
        createdById: 'owner',
        mediaFiles: [],
        createdBy: { id: 'owner' },
        ticketCategories: [{ id: 'c1', name: 'Standard', giftedCount: 3 }],
      });

      const res: any = await service.findOne('ev-1');

      expect(res.createdById).toBe('owner');
      expect(res.ticketCategories[0].giftedCount).toBe(3);
      // Garde-fou : findOne doit inclure les catégories (pas de select restrictif).
      const args = prisma.event.findUnique.mock.calls[0][0];
      expect(args.include.ticketCategories).toBeTruthy();
    });
  });
});

describe('EventsService.createEvent — stock limité/illimité', () => {
  let service: EventsService;
  let prisma: any;
  let mail: any;
  let moderation: any;
  let notifications: any;

  beforeEach(() => {
    prisma = {
      event: {
        create: jest.fn().mockResolvedValue({
          id: 'evt-1',
          status: 'PENDING_REVIEW',
          title: 'Soirée',
          createdBy: { email: 'u@x.com' },
        }),
        // Référence unique : aucune collision → 1re tentative acceptée.
        findUnique: jest.fn().mockResolvedValue(null),
      },
      uploadedAsset: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    mail = { sendEventModerationEmail: jest.fn().mockResolvedValue(undefined) };
    moderation = { generateModerationToken: jest.fn().mockReturnValue('tok') };
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    service = new EventsService(prisma, mail, moderation, notifications);
    process.env.API_BASE_URL = 'https://api.test';
    process.env.VYBE_TEAM_EMAIL = 'team@vybe.app';
  });

  function limitedDto(overrides: any = {}) {
    return {
      title: 'Soirée',
      description: 'desc',
      startDate: '2030-01-01T20:00:00Z',
      endDate: '2030-01-01T23:00:00Z',
      location: 'Kinshasa',
      purchaseDeadline: '2030-01-01T18:00:00Z',
      category: 'CONCERT',
      termsAccepted: true,
      unlimitedStock: false,
      totalCapacity: 50000,
      media: [
        {
          url: 'u',
          fileKey: 'k',
          fileName: 'a.png',
          mimeType: 'image/png',
          sizeBytes: 1,
          mediaType: 'IMAGE',
          isPoster: true,
        },
      ],
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 20000 },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 150 },
      ],
      ...overrides,
    };
  }

  it('illimité : base (index 0) à null, spéciales gardent leur plafond', async () => {
    const dto = limitedDto({ unlimitedStock: true, totalCapacity: undefined });
    await service.createEvent('user-1', dto as any);
    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.totalCapacity).toBeNull();
    const stocks = arg.data.ticketCategories.create.map((c: any) => c.totalStock);
    expect(stocks).toEqual([null, 150]); // Standard illimitée, VIP plafonnée
  });

  it('illimité : une spéciale sans totalStock → 400', async () => {
    const dto = limitedDto({
      unlimitedStock: true,
      totalCapacity: undefined,
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1' },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2' }, // spéciale sans plafond
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });

  it('une spéciale > 150 → 400 (illimité comme limité)', async () => {
    const dto = limitedDto({
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 100 },
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 200 }, // > 150
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });

  it('limité sans totalCapacity → 400', async () => {
    const dto = limitedDto({ totalCapacity: undefined });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('limité avec totalCapacity > 50000 → 400', async () => {
    const dto = limitedDto({
      totalCapacity: 50001,
      ticketCategories: [
        { name: 'A', price: 1, ticketDesignUrl: 'd', totalStock: 1 },
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('limité avec la base > 50000 → 400', async () => {
    const dto = limitedDto({
      totalCapacity: 50000,
      ticketCategories: [{ name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 50001 }],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(BadRequestException);
  });

  it('limité avec une catégorie sans totalStock → 400', async () => {
    const dto = limitedDto({
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1' },
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('limité avec somme > capacité → 400 avec le message exact', async () => {
    const dto = limitedDto({
      totalCapacity: 40000,
      ticketCategories: [
        { name: 'Standard', price: 10, ticketDesignUrl: 'd1', totalStock: 40000 }, // base ≤ 50000
        { name: 'VIP', price: 50, ticketDesignUrl: 'd2', totalStock: 150 }, // spéciale ≤ 150
      ],
    });
    await expect(service.createEvent('user-1', dto as any)).rejects.toThrow(
      'Vous avez dépassé le nombre des billets que vous avez commandé, si vous voulez un nombre plus élevé veuillez souscrire pour les billets en illimité.',
    );
  });

  it('limité avec somme ≤ capacité → crée avec totalCapacity et totalStock corrects', async () => {
    await service.createEvent('user-1', limitedDto() as any);
    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.totalCapacity).toBe(50000);
    const stocks = arg.data.ticketCategories.create.map((c: any) => c.totalStock);
    expect(stocks).toEqual([20000, 150]);
  });
});
