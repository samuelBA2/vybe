// On mocke PrismaClient pour CAPTURER les options passées à `super(...)` par
// PrismaService, sans ouvrir de vraie connexion. Le préfixe `mock` autorise la
// référence depuis la factory hoistée de jest.mock.
const mockPrismaCtor = jest.fn();

jest.mock('@prisma/client', () => ({
  PrismaClient: class {
    constructor(options?: unknown) {
      mockPrismaCtor(options);
    }
    $connect = jest.fn().mockResolvedValue(undefined);
    $disconnect = jest.fn().mockResolvedValue(undefined);
  },
}));

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    mockPrismaCtor.mockClear();
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // Neon peut être lent (réveil à froid, latence réseau) : le défaut Prisma de 5 s
  // ferme les transactions interactives multi-requêtes → un paiement peut être
  // débité alors que PAID/billets/ledger sont annulés. On exige un budget large,
  // bien au-dessus des défauts Prisma (timeout 5 s / maxWait 2 s).
  it('configure un timeout de transaction interactive largement au-dessus du défaut Prisma', () => {
    expect(mockPrismaCtor).toHaveBeenCalledTimes(1);
    const options = mockPrismaCtor.mock.calls[0][0] as {
      transactionOptions?: { timeout?: number; maxWait?: number };
    };
    expect(options?.transactionOptions?.timeout).toBeGreaterThanOrEqual(15_000);
    expect(options?.transactionOptions?.maxWait).toBeGreaterThanOrEqual(5_000);
  });
});
