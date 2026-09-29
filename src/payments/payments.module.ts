import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { ArakaProvider } from './araka.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsConfigService } from './payments-config.service';
import { PaymentsCleanupService } from './payments.cleanup';
import { EarningsController } from './earnings.controller';
import { EarningsService } from './earnings.service';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';
import { PayoutsCleanupService } from './payouts.cleanup';
import { OtpModule } from 'src/otp/otp.module';

// Module paiement. Le fournisseur concret (ArakaProvider) est lié au token
// d'injection PAYMENT_PROVIDER : tout le flux (createOrder, webhook, reaper,
// comptabilité, retraits) dépend de l'interface via ce token, jamais de
// l'implémentation → changer de fournisseur ne touche qu'à ce `useClass`.
//
// ConfigModule est global (identifiants ARAKA via ConfigService) ; PrismaModule
// fournit PrismaService (audit PaymentProviderLog). AuthModule fournit JwtService
// pour JwtAuthGuard/RolesGuard (EarningsController, PayoutsController).
@Module({
  imports: [PrismaModule, AuthModule, OtpModule],
  controllers: [PaymentsController, EarningsController, PayoutsController],
  providers: [
    { provide: PAYMENT_PROVIDER, useClass: ArakaProvider },
    PaymentsService,
    PaymentsConfigService,
    PaymentsCleanupService,
    EarningsService,
    PayoutsService,
    PayoutsCleanupService,
  ],
  exports: [PAYMENT_PROVIDER, PaymentsService],
})
export class PaymentsModule {}
