import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { CloudinaryFolder } from 'src/cloudinary/cloudinary.folder';
import { AVATAR_MAX_BYTES } from 'src/common/constants';

// `changeAvatar` fait un `await import('file-type')` (module ESM-only).
// On l'intercepte ici pour piloter la détection par MAGIC BYTES sans dépendre
// du vrai package. `fileTypeMock` est réassigné dans chaque test.
const fileTypeMock = jest.fn();
// `virtual: true` : file-type est ESM-only, Jest ne peut pas résoudre son
// chemin en CommonJS — on déclare le module comme virtuel pour le mocker.
jest.mock(
  'file-type',
  () => ({
    __esModule: true,
    fileTypeFromBuffer: (...args: any[]) => fileTypeMock(...args),
  }),
  { virtual: true },
);

// Import APRÈS jest.mock pour que le mock soit en place au chargement.
import { UsersService } from './users.service';

// Fabrique un faux fichier Multer. Par défaut : buffer non vide, taille valide.
function makeFile(overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    buffer: Buffer.from('fake-image-bytes'),
    size: 1024,
    mimetype: 'image/png',
    originalname: 'avatar.png',
    fieldname: 'file',
  } as unknown as Express.Multer.File;
  // (overrides appliqués ci-dessous)
}

describe('UsersService.changeAvatar', () => {
  let service: UsersService;
  let prisma: any;
  let cloudinary: any;

  const USER_ID = 'user-123';

  beforeEach(() => {
    fileTypeMock.mockReset();
    // Détection valide par défaut (chaque test peut la surcharger).
    fileTypeMock.mockResolvedValue({ mime: 'image/png', ext: 'png' });

    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ avatarPublicId: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    };

    cloudinary = {
      uploadImage: jest.fn().mockResolvedValue({
        secure_url: 'https://cdn/new.png',
        public_id: 'vybe/profiles/new',
      }),
      deleteImage: jest.fn().mockResolvedValue({}),
    };

    // Ordre du constructeur : prisma, jwtService, otpService, cloudinary.
    service = new UsersService(prisma, {} as any, {} as any, cloudinary);
  });

  // Petit helper pour appliquer les overrides à makeFile.
  const file = (overrides: Partial<Express.Multer.File> = {}) =>
    ({ ...makeFile(), ...overrides }) as Express.Multer.File;

  it('rejette un fichier absent ou vide (BadRequest)', async () => {
    await expect(service.changeAvatar(USER_ID, undefined as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.changeAvatar(USER_ID, file({ buffer: Buffer.alloc(0) })),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(cloudinary.uploadImage).not.toHaveBeenCalled();
  });

  it('rejette une image trop volumineuse (PayloadTooLarge)', async () => {
    await expect(
      service.changeAvatar(USER_ID, file({ size: AVATAR_MAX_BYTES + 1 })),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    expect(fileTypeMock).not.toHaveBeenCalled();
    expect(cloudinary.uploadImage).not.toHaveBeenCalled();
  });

  it('rejette un type non détecté (UnsupportedMediaType)', async () => {
    fileTypeMock.mockResolvedValue(undefined);

    await expect(service.changeAvatar(USER_ID, file())).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    expect(cloudinary.uploadImage).not.toHaveBeenCalled();
  });

  it('rejette un type détecté mais non autorisé (ex: gif)', async () => {
    fileTypeMock.mockResolvedValue({ mime: 'image/gif', ext: 'gif' });

    await expect(service.changeAvatar(USER_ID, file())).rejects.toBeInstanceOf(
      UnsupportedMediaTypeException,
    );
    expect(cloudinary.uploadImage).not.toHaveBeenCalled();
  });

  it('rejette si utilisateur introuvable (NotFound)', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.changeAvatar(USER_ID, file())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(cloudinary.uploadImage).not.toHaveBeenCalled();
  });

  it('upload dans le dossier PROFILE_PHOTOS, enregistre URL+publicId et retourne l’URL', async () => {
    const res = await service.changeAvatar(USER_ID, file());

    expect(cloudinary.uploadImage).toHaveBeenCalledWith(
      expect.anything(),
      CloudinaryFolder.PROFILE_PHOTOS,
    );
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: {
        avatarUrl: 'https://cdn/new.png',
        avatarPublicId: 'vybe/profiles/new',
      },
    });
    // Pas d'ancienne image → pas de suppression.
    expect(cloudinary.deleteImage).not.toHaveBeenCalled();
    expect(res).toEqual({ avatarUrl: 'https://cdn/new.png' });
  });

  it('supprime l’ancienne image Cloudinary quand un avatarPublicId existait', async () => {
    prisma.user.findUnique.mockResolvedValue({ avatarPublicId: 'vybe/profiles/old' });

    await service.changeAvatar(USER_ID, file());

    expect(cloudinary.deleteImage).toHaveBeenCalledWith('vybe/profiles/old');
  });

  it('convertit un échec d’upload en BadRequest et n’écrit rien en base', async () => {
    cloudinary.uploadImage.mockRejectedValue(new Error('cloudinary down'));

    await expect(service.changeAvatar(USER_ID, file())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('n’échoue pas si la suppression de l’ancienne image plante (image orpheline tolérée)', async () => {
    prisma.user.findUnique.mockResolvedValue({ avatarPublicId: 'vybe/profiles/old' });
    cloudinary.deleteImage.mockRejectedValue(new Error('destroy failed'));

    const res = await service.changeAvatar(USER_ID, file());

    // La nouvelle photo est déjà posée : on retourne quand même son URL.
    expect(res).toEqual({ avatarUrl: 'https://cdn/new.png' });
  });
});
