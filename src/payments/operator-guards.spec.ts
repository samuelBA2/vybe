import { BadRequestException } from '@nestjs/common';
import type { ProviderOperator } from './payment-provider.interface';
import { assertPhoneMatchesOperator } from './operator-guards';

const mpesa: ProviderOperator = {
  code: 'MPESA', name: 'Vodacom M-Pesa', available: true,
  currencies: ['USD', 'CDF'], phonePrefixes: ['81', '82', '83'],
};

describe('assertPhoneMatchesOperator', () => {
  it('accepte un numéro conforme en 243… / 0… / national', () => {
    expect(() => assertPhoneMatchesOperator(mpesa, '243810000000')).not.toThrow();
    expect(() => assertPhoneMatchesOperator(mpesa, '0820000000')).not.toThrow();
    expect(() => assertPhoneMatchesOperator(mpesa, '830000000')).not.toThrow();
  });

  it('rejette un numéro qui ne correspond pas à l’opérateur', () => {
    expect(() => assertPhoneMatchesOperator(mpesa, '243840000000')).toThrow(
      new BadRequestException('Champ mal rempli, resseyez'),
    );
  });

  it('ne contrôle rien si l’opérateur n’a pas de préfixes', () => {
    expect(() =>
      assertPhoneMatchesOperator({ ...mpesa, phonePrefixes: undefined }, '243840000000'),
    ).not.toThrow();
  });
});