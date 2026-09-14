import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { PawaPayProvider } from './pawapay.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

// Module paiement. Le fournisseur concret (PawaPayProvider) est lié au token
// d'injection PAYMENT_PROVIDER : tout le flux (createOrder, webhook, reaper,
// comptabilité) dépend de l'interface via ce token, jamais de l'implémentation
// → changer de fournisseur ne touche qu'à ce `useClass`.
//
// ConfigModule est global (token/base URL/clé publique via ConfigService) ;
// PrismaModule fournit PrismaService (audit PaymentProviderLog).
//
// Webhook (POST /payments/webhook) + service branchés (Task 5). À venir : reaper
// (Task 7) ; enregistrement dans AppModule (Task 10).
@Module({
  imports: [PrismaModule],
  controllers: [PaymentsController],
  providers: [
    { provide: PAYMENT_PROVIDER, useClass: PawaPayProvider },
    PaymentsService,
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
