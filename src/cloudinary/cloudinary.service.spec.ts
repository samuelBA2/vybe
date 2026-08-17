import { Test, TestingModule } from '@nestjs/testing';
import { CloudinaryService } from './cloudinary.service';
import { Writable } from 'stream';

const uploadStreamMock = jest.fn();
jest.mock('cloudinary', () => ({
  v2: { uploader: { upload_stream: (...args: any[]) => uploadStreamMock(...args) } },
}));

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
