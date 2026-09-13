import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';

// Socle du module paiement — INDÉPENDANT du fournisseur (Task 3).
//
// L'implémentation concrète du PaymentProvider (PawaPayProvider) et son binding
// sur le token PAYMENT_PROVIDER seront ajoutés en Task 3b, une fois écrite :
//
//   providers: [{ provide: PAYMENT_PROVIDER, useClass: PawaPayProvider }],
//   exports:   [PAYMENT_PROVIDER],
//
// Tant que le provider concret n'existe pas, on n'expose RIEN : exporter le token
// PAYMENT_PROVIDER sans provider lié casserait le bootstrap Nest. Les Tasks 4–7
// consomment l'interface via un provider MOCKÉ dans leurs tests, pas ce module.
//
// Le controller webhook, le service et le reaper viendront enrichir ce module
// (Tasks 5 & 7) ; l'enregistrement dans AppModule se fait en Task 10.
@Module({
  imports: [PrismaModule],
  providers: [],
  exports: [],
})
export class PaymentsModule {}
