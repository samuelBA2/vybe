import sharp from 'sharp';
import * as QRCode from 'qrcode';
import { TicketAssetService, TicketFields } from './ticket-asset.service';

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

  it('rend une carte PNG de dimensions fixes quelle que soit la taille du design', async () => {
    const png = await service.buildTicketImage(await makeDesign(1200, 400), baseFields);
    const meta = await sharp(png).metadata();
    expect(meta.width).toBe(750);
    expect(meta.height).toBe(1040);
  });

  it('encode le qrToken brut dans le QR', async () => {
    const spy = jest.spyOn(QRCode, 'toBuffer');
    await service.buildTicketImage(await makeDesign(400, 400), baseFields);
    expect(spy.mock.calls[0][0]).toBe(baseFields.qrToken);
    spy.mockRestore();
  });

  it('échappe les valeurs texte sans casser le rendu', async () => {
    const png = await service.buildTicketImage(await makeDesign(400, 400), {
      ...baseFields, eventTitle: 'Rock & <Roll>',
    });
    expect(Buffer.isBuffer(png)).toBe(true);
  });
});