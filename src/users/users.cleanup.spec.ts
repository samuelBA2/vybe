import { Logger } from '@nestjs/common';
import { AccountsCleanupService } from './users.cleanup';

function makePrisma(users: any[]) {
  return {
    user: {
      findMany: jest.fn().mockResolvedValue(users),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}
function makeCloudinary() {
  return { deleteAsset: jest.fn().mockResolvedValue({}) } as any;
}

describe('AccountsCleanupService.purgeSoftDeleted', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sélectionne isValid=false ET deletionRequestedAt < cutoff', async () => {
    const prisma = makePrisma([]);
    await new AccountsCleanupService(prisma, makeCloudinary()).purgeSoftDeleted();
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.isValid).toBe(false);
    expect(where.deletionRequestedAt.lt).toBeInstanceOf(Date);
  });

  it('aucun compte éligible → aucune action', async () => {
    const prisma = makePrisma([]);
    const cloudinary = makeCloudinary();
    await new AccountsCleanupService(prisma, cloudinary).purgeSoftDeleted();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(cloudinary.deleteAsset).not.toHaveBeenCalled();
  });

  it('compte éligible → efface les champs perso + deletionRequestedAt=null', async () => {
    const prisma = makePrisma([{ id: 'u1', avatarPublicId: null }]);
    await new AccountsCleanupService(prisma, makeCloudinary()).purgeSoftDeleted();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        email: null,
        phone: null,
        hashedPassword: null,
        firstname: null,
        lastname: null,
        avatarUrl: null,
        avatarPublicId: null,
        deletionRequestedAt: null,
      },
    });
  });

  it('compte avec avatar → supprime l’avatar Cloudinary (image)', async () => {
    const prisma = makePrisma([{ id: 'u1', avatarPublicId: 'avatars/u1' }]);
    const cloudinary = makeCloudinary();
    await new AccountsCleanupService(prisma, cloudinary).purgeSoftDeleted();
    expect(cloudinary.deleteAsset).toHaveBeenCalledWith('avatars/u1', 'image');
  });

  it('échec sur un compte → loggé, la boucle continue', async () => {
    const prisma = makePrisma([
      { id: 'u1', avatarPublicId: 'avatars/u1' },
      { id: 'u2', avatarPublicId: null },
    ]);
    const cloudinary = makeCloudinary();
    cloudinary.deleteAsset.mockRejectedValueOnce(new Error('Cloudinary down'));
    await new AccountsCleanupService(prisma, cloudinary).purgeSoftDeleted();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u2' } }),
    );
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
