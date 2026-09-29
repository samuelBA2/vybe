import { BadRequestException } from '@nestjs/common';
import { assertPhoneMatchesOperator } from './operator-guards';

const mpesa = {
  code: 'MPESA',
  name: 'M-Pesa',
  available: true,
  currencies: ['USD', 'CDF'] as ('USD' | 'CDF')[],
  phonePrefixes: ['81', '82', '83'],
};

describe('assertPhoneMatchesOperator (V4)', () => {
  it('numéro M-Pesa (243 81…) avec MPESA → OK', () => {
    expect(() =>
      assertPhoneMatchesOperator(mpesa, '243810000001'),
    ).not.toThrow();
  });

  it('numéro Airtel (243 97…) avec MPESA → 400', () => {
    expect(() => assertPhoneMatchesOperator(mpesa, '243970000001')).toThrow(
      BadRequestException,
    );
  });

  it('opérateur sans préfixes connus → pas de contrôle', () => {
    expect(() =>
      assertPhoneMatchesOperator(
        { ...mpesa, phonePrefixes: undefined },
        '243970000001',
      ),
    ).not.toThrow();
  });
});
