import sharp from 'sharp';
import { TicketAssetService, TicketFields } from './ticket-asset.service';

// qrcode.toBuffer est non-configurable → on mocke le module au lieu de le spy.
jest.mock('qrcode', () => ({ toBuffer: jest.fn() }));
import * as QRCode from 'qrcode';

async function makeDesign(w: number, h: number): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: '#334155' } }).png().toBuffer();
}

const baseFields: TicketFields = {
  qrToken: '11111111-1111-4111-8111-111111111111',
  eventCategory: 'FESTIVAL',
  eventTitle: 'Neon Nights',
  dateLabel: 'Ven. 27 juin',
  timeLabel: '22:00',
  placeLabel: 'Standard',
};

describe('TicketAssetService.buildTicketImage', () => {
  const service = new TicketAssetService({} as any, {} as any);
  let qrPng: Buffer;

  beforeAll(async () => {
    // PNG valide minimal renvoyé par le mock qrcode.
    qrPng = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000000' } }).png().toBuffer();
  });

  beforeEach(() => {
    (QRCode.toBuffer as jest.Mock).mockReset();
    (QRCode.toBuffer as jest.Mock).mockResolvedValue(qrPng);
  });

  it('rend une carte PNG de dimensions fixes quelle que soit la taille du design', async () => {
    const png = await service.buildTicketImage(await makeDesign(1200, 400), baseFields);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(750);
    expect(meta.height).toBe(1040);
  });

  it('encode le qrToken brut dans le QR', async () => {
    await service.buildTicketImage(await makeDesign(400, 400), baseFields);
    expect((QRCode.toBuffer as jest.Mock).mock.calls[0][0]).toBe(baseFields.qrToken);
  });

  it('échappe les valeurs texte sans casser le rendu', async () => {
    const png = await service.buildTicketImage(await makeDesign(400, 400), {
      ...baseFields, eventTitle: 'Rock & <Roll>',
    });
    expect(Buffer.isBuffer(png)).toBe(true);
  });


describe('TicketAssetService.buildTicketPdf', () => {
  const service = new TicketAssetService({} as any, {} as any);

  it('renvoie un buffer PDF (magic %PDF)', async () => {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#000000' } }).png().toBuffer();
    const pdf = await service.buildTicketPdf(png);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });
});
describe('TicketAssetService.generateAssetsForOrder', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const evt = { category: 'FESTIVAL', title: 'Neon Nights', startDate: new Date('2026-06-27T22:00:00') };

  function buildService(overrides: { rawRejectsForTicket?: string } = {}) {
    const prisma = {
      ticket: {
        findMany: jest.fn().mockResolvedValue([
          { id: 't1', qrToken: 'q1', ticketCategoryId: 'c1', ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png', event: evt } },
          { id: 't2', qrToken: 'q2', ticketCategoryId: 'c1', ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png', event: evt } },
          { id: 't3', qrToken: 'q3', ticketCategoryId: 'c2', ticketCategory: { name: 'Standard', ticketDesignUrl: 'https://d/std.png', event: evt } },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    } as any;
    const cloudinary = {
      uploadBuffer: jest.fn().mockResolvedValue({ secure_url: 'https://cdn/img.png' }),
      uploadRawBuffer: jest.fn().mockImplementation((_b: Buffer, _f: string, name: string) => {
        if (overrides.rawRejectsForTicket && name.includes(overrides.rawRejectsForTicket)) {
          return Promise.reject(new Error('upload raw KO'));
        }
        return Promise.resolve({ secure_url: 'https://cdn/doc.pdf' });
      }),
    } as any;
    const service = new TicketAssetService(prisma, cloudinary);
    jest.spyOn(service, 'buildTicketImage').mockResolvedValue(Buffer.from('PNG'));
    jest.spyOn(service, 'buildTicketPdf').mockResolvedValue(Buffer.from('%PDF'));
    return { service, prisma };
  }

  it('télécharge le design une seule fois par catégorie et met à jour chaque billet', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    global.fetch = fetchMock as any;
    const { service, prisma } = buildService();

    await service.generateAssetsForOrder('order-1');

    expect(fetchMock).toHaveBeenCalledTimes(2); // 2 catégories, 3 billets
    expect(prisma.ticket.update).toHaveBeenCalledTimes(3);
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { ticketImageUrl: 'https://cdn/img.png', pdfUrl: 'https://cdn/doc.pdf' },
    });
  });

  it('best-effort : l\'échec d\'un billet n\'empêche pas les autres et ne throw pas', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as any;
    const { service, prisma } = buildService({ rawRejectsForTicket: 't1' });

    await expect(service.generateAssetsForOrder('order-1')).resolves.toBeUndefined();
    expect(prisma.ticket.update).toHaveBeenCalledTimes(2);
  });
});

describe('TicketAssetService.regenerateMissingForUser', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  const evt = { category: 'FESTIVAL', title: 'Neon Nights', startDate: new Date('2026-06-27T22:00:00') };
  const missing = {
    id: 't1', qrToken: 'q1', ticketCategoryId: 'c1',
    ticketCategory: { name: 'VIP', ticketDesignUrl: 'https://d/vip.png', event: evt },
  };

  function buildService(findManyImpl: jest.Mock) {
    const prisma = { ticket: { findMany: findManyImpl, update: jest.fn().mockResolvedValue({}) } } as any;
    const cloudinary = {
      uploadBuffer: jest.fn().mockResolvedValue({ secure_url: 'https://cdn/img.png' }),
      uploadRawBuffer: jest.fn().mockResolvedValue({ secure_url: 'https://cdn/doc.pdf' }),
    } as any;
    const service = new TicketAssetService(prisma, cloudinary);
    jest.spyOn(service, 'buildTicketImage').mockResolvedValue(Buffer.from('PNG'));
    jest.spyOn(service, 'buildTicketPdf').mockResolvedValue(Buffer.from('%PDF'));
    return { service, prisma };
  }

  it('ne charge que les billets aux URLs manquantes et les régénère', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }) as any;
    const findMany = jest.fn().mockResolvedValue([missing]);
    const { service, prisma } = buildService(findMany);

    await service.regenerateMissingForUser('user-1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { order: { userId: 'user-1' }, OR: [{ ticketImageUrl: null }, { pdfUrl: null }] },
      }),
    );
    expect(prisma.ticket.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { ticketImageUrl: 'https://cdn/img.png', pdfUrl: 'https://cdn/doc.pdf' },
    });
  });

  it('aucun manquant → pas de génération, ne throw pas', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const { service, prisma } = buildService(findMany);
    await expect(service.regenerateMissingForUser('user-1')).resolves.toBeUndefined();
    expect(prisma.ticket.update).not.toHaveBeenCalled();
  });

  it('garde-fou : un 2ᵉ appel concurrent pour le même user ne relance pas findMany', async () => {
    let resolveFind: (v: any) => void;
    const findMany = jest.fn().mockReturnValueOnce(new Promise((r) => { resolveFind = r; }));
    const { service } = buildService(findMany);

    const p1 = service.regenerateMissingForUser('user-1'); // en vol, bloqué sur findMany
    await service.regenerateMissingForUser('user-1');       // sauté par le garde-fou

    expect(findMany).toHaveBeenCalledTimes(1);
    resolveFind!([]);
    await p1;
  });
});
});
