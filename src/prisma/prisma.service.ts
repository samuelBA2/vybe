import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  // Neon (plan gratuit) suspend le compte après inactivité : la première
  // connexion peut échouer le temps que la base se réveille (~quelques secondes).
  // On retente au démarrage au lieu de faire crasher tout le boot de l'app.
  // NB : ne s'exécute qu'au lancement, ne maintient PAS la base éveillée ensuite.
  async onModuleInit() {
    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        this.logger.warn(
          `Connexion à la base échouée (tentative ${attempt}/${maxAttempts}), nouvel essai dans 2s…`,
        );
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
