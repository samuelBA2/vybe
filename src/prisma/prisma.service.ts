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

  constructor() {
    // Budget de temps des transactions interactives. Le défaut Prisma (timeout 5 s,
    // maxWait 2 s) est trop serré face à la latence Neon (réveil à froid + réseau) :
    // une transaction argent multi-requêtes (fulfill/settle → billets + ledger + PAID,
    // ×N commandes du panier) peut dépasser 5 s, Prisma la ferme, et le paiement se
    // retrouve débité mais PAID/billets/ledger annulés. Plafond large : en usage
    // normal une tx dure quelques ms, ce budget ne borne que les cas pathologiques.
    super({ transactionOptions: { maxWait: 10_000, timeout: 20_000 } });
  }

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
