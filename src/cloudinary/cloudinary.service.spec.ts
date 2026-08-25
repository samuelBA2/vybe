import { CloudinaryService } from './cloudinary.service';
import { Writable } from 'stream';

const uploadStreamMock = jest.fn();
jest.mock('cloudinary', () => ({
  v2: {
    uploader: {
      upload_stream: (...args: any[]) => uploadStreamMock(...args),
      destroy: jest.fn().mockResolvedValue({ result: 'ok' }),
    },
  },
}));
import { v2 as cloudinary } from 'cloudinary';

describe('CloudinaryService.uploadRawBuffer', () => {
  beforeEach(() => {
    uploadStreamMock.mockReset();
    uploadStreamMock.mockImplementation((_opts: any, cb: any) => {
      const sink = new Writable({ write(_c, _e, done) { done(); } });
      process.nextTick(() => cb(null, { secure_url: 'https://cdn/x.pdf', public_id: 'p' }));
      return sink;
    });
  });

  it('upload en resource_type raw et renvoie le résultat', async () => {
    const service = new CloudinaryService();
    const res = await service.uploadRawBuffer(Buffer.from('%PDF-1.4'), 'vybe/tickets', 'ticket-1');
    expect(res.secure_url).toBe('https://cdn/x.pdf');
    const opts = uploadStreamMock.mock.calls[0][0];
    expect(opts.resource_type).toBe('raw');
    expect(opts.format).toBe('pdf');
    expect(opts.public_id).toBe('ticket-1');
  });
});

describe('CloudinaryService.deleteAsset', () => {
  const service = new CloudinaryService();
  const destroy = cloudinary.uploader.destroy as jest.Mock;

  beforeEach(() => destroy.mockClear());

  it('resource_type raw pour un PDF', async () => {
    await service.deleteAsset('tickets/ticket-xyz.pdf', 'raw');
    expect(destroy).toHaveBeenCalledWith('tickets/ticket-xyz.pdf', { resource_type: 'raw' });
  });

  it('resource_type image par défaut', async () => {
    await service.deleteAsset('tickets/abc123');
    expect(destroy).toHaveBeenCalledWith('tickets/abc123', { resource_type: 'image' });
  });
});
