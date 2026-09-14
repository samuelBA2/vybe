import { Inject, Injectable } from '@nestjs/common';
import { USD_TO_CDF_RATE } from 'src/common/constants';
import { PAYMENT_PROVIDER } from './payment-provider.interface';
import type {
  PaymentProvider,
  ProviderOperator,
} from './payment-provider.interface';

// Config publique du checkout : taux USD→CDF (base comptable USD, affichage CDF)
// + opérateurs Mobile Money disponibles. Un seul appel au chargement du checkout.
@Injectable()
export class PaymentsConfigService {
  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
  ) {}

  async getConfig(): Promise<{
    usdToCdfRate: number;
    operators: ProviderOperator[];
  }> {
    const operators = await this.payment.getOperators();
    return { usdToCdfRate: USD_TO_CDF_RATE, operators };
  }
}
