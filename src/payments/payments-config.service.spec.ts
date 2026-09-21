import { PaymentsConfigService } from './payments-config.service';
import { USD_TO_CDF_RATE } from 'src/common/constants';
import { PaymentProvider } from './payment-provider.interface';

describe('PaymentsConfigService', () => {
  it('getConfig = taux figé + opérateurs du fournisseur', async () => {
    const operators = [
      { code: 'VODACOM_MPESA_COD', name: 'Vodacom M-Pesa', available: true, currencies: ['CDF', 'USD'] },
    ];
    const provider = {
      getOperators: jest.fn().mockResolvedValue(operators),
    } as unknown as PaymentProvider;

    const service = new PaymentsConfigService(provider);
    const res = await service.getConfig();

    expect(res).toEqual({ usdToCdfRate: USD_TO_CDF_RATE, operators });
    expect((provider.getOperators as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
