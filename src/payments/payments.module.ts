import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { PawaPayProvider } from './pawapay.provider';

// Module paiement. Le fournisseur concret (PawaPayProvider) est lié au token
// d'injection PAYMENT_PROVIDER : tout le flux (createOrder, webhook, reaper,
// comptabilité) dépend de l'interface via ce token, jamais de l'implémentation
// → changer de fournisseur ne touche qu'à ce `useClass`.
//
// ConfigModule est global (token/base URL/clé publique via ConfigService) ;
// PrismaModule fournit PrismaService (audit PaymentProviderLog).
//
// À venir : controller webhook + service (Task 5), reaper (Task 7) ;
// enregistrement dans AppModule (Task 10).
@Module({
  imports: [PrismaModule],
  providers: [{ provide: PAYMENT_PROVIDER, useClass: PawaPayProvider }],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
