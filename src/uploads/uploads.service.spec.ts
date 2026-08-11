import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { UploadsService } from './uploads.service';
import { MAX_BYTES } from 'src/common/constants';

// file-type est ESM-only et importé dynamiquement dans le service. On le mocke
// pour piloter le type détecté sans dépendre du vrai module ni de vrais octets.
// virtual: true car file-type est ESM-only et le resolver CommonJS de Jest ne
// sait pas le localiser — on fournit donc un module fictif intercepté à l'import().
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }), {
  virtual: true,
});
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fileTypeFromBuffer } = require('file-type') as {
  fileTypeFromBuffer: jest.Mock;
};

// Construit un faux Express.Multer.File. buffer non vide par défaut pour passer
// le garde-fou "fichier vide" ; size réglable indépendamment pour tester la taille.
function buildFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: 'photo.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 1024,
    buffer: Buffer.from('data'),
    stream: undefined as any,
    destination: '',
    filename: '',
    path: '',
    ...overrides,
  };
}

describe('UploadsService.upload', () => {
  let service: UploadsService;
  let cloudinary: { uploadFile: jest.Mock };
  let prisma: { uploadedAsset: { create: jest.Mock } };

  beforeEach(() => {
    jest.clearAllMocks();
    cloudinary = {
      uploadFile: jest.fn().mockResolvedValue({
        public_id: 'vybe/events/abc123',
        secure_url: 'https://cdn.cloudinary/vybe/events/abc123.png',
      }),
    };
    prisma = {
      uploadedAsset: { create: jest.fn().mockResolvedValue({}) },
    };
    service = new UploadsService(cloudinary as any, prisma as any);
  });

  it('rejette un fichier absent (BadRequest)', async () => {
    await expect(service.upload(undefined as any, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(cloudinary.uploadFile).not.toHaveBeenCalled();
  });

  it('rejette un buffer vide (BadRequest)', async () => {
    const file = buildFile({ buffer: Buffer.alloc(0) });
    await expect(service.upload(file, 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    expect(fileTypeFromBuffer).not.toHaveBeenCalled();
  });

  it('rejette un fichier trop volumineux (PayloadTooLarge)', async () => {
    const file = buildFile({ size: MAX_BYTES + 1 });
    await expect(service.upload(file, 'user-1')).rejects.toThrow(
      PayloadTooLargeException,
    );
    // La revalidation taille passe AVANT la détection de type.
    expect(fileTypeFromBuffer).not.toHaveBeenCalled();
    expect(cloudinary.uploadFile).not.toHaveBeenCalled();
  });

  it('rejette un type indétectable (UnsupportedMediaType)', async () => {
    fileTypeFromBuffer.mockResolvedValue(undefined);
    await expect(service.upload(buildFile(), 'user-1')).rejects.toThrow(
      UnsupportedMediaTypeException,
    );
    expect(cloudinary.uploadFile).not.toHaveBeenCalled();
  });

  it('rejette un type non autorisé (UnsupportedMediaType)', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'text/plain', ext: 'txt' });
    await expect(service.upload(buildFile(), 'user-1')).rejects.toThrow(
      UnsupportedMediaTypeException,
    );
    expect(cloudinary.uploadFile).not.toHaveBeenCalled();
  });

  it("ignore le mimetype client falsifié et se fie aux magic bytes", async () => {
    // Le client prétend "image/png" mais les octets sont un exécutable → refus.
    fileTypeFromBuffer.mockResolvedValue({
      mime: 'application/x-msdownload',
      ext: 'exe',
    });
    const file = buildFile({ mimetype: 'image/png' });
    await expect(service.upload(file, 'user-1')).rejects.toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it('upload une image : resource_type "image", asset orphelin, contrat complet', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    const file = buildFile({ originalname: 'photo.png', size: 2048 });

    const result = await service.upload(file, 'user-42');

    // Route Cloudinary en mode image.
    expect(cloudinary.uploadFile).toHaveBeenCalledWith(
      file,
      expect.any(String),
      'image',
    );
    // Asset enregistré comme orphelin (attached:false), rattaché à l'owner.
    expect(prisma.uploadedAsset.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        publicId: 'vybe/events/abc123',
        ownerId: 'user-42',
        attached: false,
        mediaType: 'IMAGE',
        mimeType: 'image/png',
        sizeBytes: 2048,
        fileName: 'photo.png',
      }),
    });
    // Contrat de retour EXACT.
    expect(result).toEqual({
      url: 'https://cdn.cloudinary/vybe/events/abc123.png',
      fileKey: 'vybe/events/abc123',
      fileName: 'photo.png',
      mimeType: 'image/png',
      sizeBytes: 2048,
      mediaType: 'IMAGE',
    });
  });

  it('upload un PDF : resource_type "auto" et mediaType DOCUMENT', async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'application/pdf', ext: 'pdf' });
    const file = buildFile({ originalname: 'billet.pdf', mimetype: 'application/pdf' });

    const result = await service.upload(file, 'user-1');

    expect(cloudinary.uploadFile).toHaveBeenCalledWith(
      file,
      expect.any(String),
      'auto',
    );
    expect(result.mediaType).toBe('DOCUMENT');
    expect(result.mimeType).toBe('application/pdf');
  });

  it("remonte une erreur claire si Cloudinary échoue et n'enregistre rien", async () => {
    fileTypeFromBuffer.mockResolvedValue({ mime: 'image/png', ext: 'png' });
    cloudinary.uploadFile.mockRejectedValue(new Error('cloudinary down'));

    await expect(service.upload(buildFile(), 'user-1')).rejects.toThrow(
      BadRequestException,
    );
    // Aucun asset orphelin ne doit être créé si l'upload distant a échoué.
    expect(prisma.uploadedAsset.create).not.toHaveBeenCalled();
  });
});
