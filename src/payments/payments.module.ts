import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from 'src/prisma/prisma.module';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthModule } from 'src/auth/auth.module';
import { MailModule } from 'src/mail/mail.module';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import { PawaPayProvider } from './pawapay.provider';
import { ArakaProvider } from './araka.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { PaymentsConfigService } from './payments-config.service';
import { PaymentsCleanupService } from './payments.cleanup';
import { EarningsController } from './earnings.controller';
import { EarningsService } from './earnings.service';
import { PayoutsController } from './payouts.controller';
import { PayoutsService } from './payouts.service';

// Module paiement. Le fournisseur concret est lié au token PAYMENT_PROVIDER :
// tout le flux (createOrder, webhook, reaper, comptabilité) dépend de
// l'interface, jamais de l'implémentation. `PAYMENT_PROVIDER=araka|pawapay`
// (défaut : araka) choisit l'implémentation.
//
// ConfigModule est global (identifiants via ConfigService) ;
// PrismaModule fournit PrismaService (audit PaymentProviderLog).
@Module({
  imports: [PrismaModule, AuthModule, MailModule],
  controllers: [PaymentsController, EarningsController, PayoutsController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (config: ConfigService, prisma: PrismaService) => {
        const which = (config.get<string>('PAYMENT_PROVIDER') ?? 'araka')
          .trim()
          .toLowerCase();
        const logger = new Logger('PaymentsModule');
        if (which === 'pawapay') {
          logger.log('Fournisseur de paiement : PawaPay');
          return new PawaPayProvider(config, prisma);
        }
        if (which === 'araka') {
          logger.log('Fournisseur de paiement : Araka');
          return new ArakaProvider(config, prisma);
        }
        throw new Error(
          `PAYMENT_PROVIDER inconnu (« ${which} »). Valeurs acceptées : araka, pawapay.`,
        );
      },
      inject: [ConfigService, PrismaService],
    },
    PaymentsService,
    PaymentsConfigService,
    PaymentsCleanupService,
    EarningsService,
    PayoutsService,
  ],
  exports: [PAYMENT_PROVIDER, PaymentsService],
})
export class PaymentsModule {}
