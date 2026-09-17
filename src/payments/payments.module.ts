import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { PawaPayProvider } from './pawapay.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsConfigService } from './payments-config.service';
import { PaymentsCleanupService } from './payments.cleanup';
import { EarningsController } from './earnings.controller';
import { EarningsService } from './earnings.service';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PayoutsCleanupService } from './payouts.cleanup';

// Module paiement. Le fournisseur concret (PawaPayProvider) est lié au token
// d'injection PAYMENT_PROVIDER : tout le flux (createOrder, webhook, reaper,
// comptabilité) dépend de l'interface via ce token, jamais de l'implémentation
// → changer de fournisseur ne touche qu'à ce `useClass`.
//
// ConfigModule est global (token/base URL/clé publique via ConfigService) ;
// PrismaModule fournit PrismaService (audit PaymentProviderLog).
//
// Webhook (POST /payments/webhook) + service + reaper + comptabilité organisateur
// (GET /me/earnings) + retrait (/me/payouts) branchés (Tasks 5, 7, 8, 10).
// AuthModule fournit JwtService pour JwtAuthGuard/RolesGuard (EarningsController,
// PayoutsController). À venir : enregistrement dans AppModule (Task 10 finale).
@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [PaymentsController, EarningsController, PayoutsController],
  providers: [
    { provide: PAYMENT_PROVIDER, useClass: PawaPayProvider },
    PaymentsService,
    PaymentsConfigService,
    PaymentsCleanupService,
    EarningsService,
    PayoutsService,
    PayoutsCleanupService,
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
