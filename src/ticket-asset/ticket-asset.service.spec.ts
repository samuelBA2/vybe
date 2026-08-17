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
});
