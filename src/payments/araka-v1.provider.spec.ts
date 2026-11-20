import { createHmac } from 'crypto';
import { ArakaV1Provider } from './araka-v1.provider';
import { PrismaService } from 'src/prisma/prisma.service';
import { InitPaymentInput } from './payment-provider.interface';

function fakeResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

// Valeurs FICTIVES de test : aucune clé réelle n'est utilisée ici.
const TEST_ENV: Record<string, string> = {
  ARAKA_BASE_URL: 'https://araka.test/',
  ARAKA_PUBLIC_KEY: 'pk_test_dummy',
  ARAKA_SECRET_KEY: 'sk_test_dummy',
  ARAKA_WEBHOOK_SECRET: 'whsec_test_4f9a2c7e1b8d',
  API_BASE_URL: 'https://api.vybe.test',
};

describe('ArakaV1Provider', () => {
  let provider: ArakaV1Provider;
  let fetchMock: jest.Mock;
  let env: Record<string, string | undefined>;
  const prisma = {
    paymentProviderLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const payment: InitPaymentInput = {
    paymentRef: 'abcdef0123456789abcd',
    amount: 12.5,
    currency: 'USD',
    operator: 'MPESA',
    phoneNumber: '0810000000',
    customerFullName: 'Ada Lovelace',
    customerEmail: 'ada@vybe.test',
  };

  function build() {
    const config = { get: jest.fn((key: string) => env[key]) };
    provider = new ArakaV1Provider(
      config as never,
      prisma as unknown as PrismaService,
    );
  }

  beforeEach(() => {
    env = { ...TEST_ENV };
    build();
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    prisma.paymentProviderLog.create.mockClear();
  });

  function mockToken(accessToken = 'tok-1', expiresIn = 3600) {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ accessToken, tokenType: 'Bearer', expiresIn }),
    );
  }

  function pending(ref = payment.paymentRef) {
    return fakeResponse(
      {
        responseCode: '201',
        responseDescription: 'Pending',
        data: {
          systemReference: 'TXN-1',
          externalReference: ref,
          status: 'Pending',
          idempotentReplay: false,
        },
      },
      201,
    );
  }

  describe('initPayment', () => {
    it('obtient un jeton par clés puis crée la commande au format v1', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(pending());

      const res = await provider.initPayment(payment);
      expect(res).toEqual({ paymentRef: payment.paymentRef });

      const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe('https://araka.test/v1/auth/token');
      expect(JSON.parse(tokenInit.body)).toEqual({
        publicKey: 'pk_test_dummy',
        secretKey: 'sk_test_dummy',
      });
      expect(tokenInit.headers.Authorization).toBeUndefined();

      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe('https://araka.test/v1/createpaymentorder');
      expect(init.method).toBe('POST');
      expect(init.headers.Authorization).toBe('Bearer tok-1');
      expect(init.headers['Idempotency-Key']).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      // Corps EXACT : l'API rejette les propriétés inconnues.
      expect(JSON.parse(init.body)).toEqual({
        externalReference: payment.paymentRef,
        amount: 12.5,
        currency: 'USD',
        redirectUrl: 'https://api.vybe.test/payments/webhook',
        customer: {
          name: 'Ada Lovelace',
          phone: '243810000000',
          email: 'ada@vybe.test',
        },
        walletId: '243810000000',
      });
    });

    it('réutilise le jeton tant qu’il est valide', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(pending());
      fetchMock.mockResolvedValueOnce(pending('ref2'));
      await provider.initPayment(payment);
      await provider.initPayment({ ...payment, paymentRef: 'ref2' });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('Idempotency-Key stable pour une même référence (réessai sans double débit)', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(pending());
      fetchMock.mockResolvedValueOnce(pending());
      fetchMock.mockResolvedValueOnce(pending('autre'));
      await provider.initPayment(payment);
      await provider.initPayment(payment);
      await provider.initPayment({ ...payment, paymentRef: 'autre' });
      const keys = fetchMock.mock.calls
        .slice(1)
        .map(([, init]) => init.headers['Idempotency-Key']);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it('relance une fois l’authentification sur 401', async () => {
      mockToken('vieux');
      fetchMock.mockResolvedValueOnce(fakeResponse({}, 401));
      mockToken('neuf');
      fetchMock.mockResolvedValueOnce(pending());
      await provider.initPayment(payment);
      expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe(
        'Bearer neuf',
      );
    });

    it('omet l’e-mail absent et arrondit le CDF à l’entier', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(pending());
      await provider.initPayment({
        ...payment,
        currency: 'CDF',
        amount: 28125.4,
        customerEmail: undefined,
      });
      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.amount).toBe(28125);
      expect(body.customer).toEqual({
        name: 'Ada Lovelace',
        phone: '243810000000',
      });
    });

    it('refuse un numéro dont le préfixe ne correspond pas à l’opérateur choisi', async () => {
      await expect(
        provider.initPayment({ ...payment, operator: 'AIRTEL' }),
      ).rejects.toThrow(/opérateur/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuse un préfixe inconnu', async () => {
      await expect(
        provider.initPayment({ ...payment, phoneNumber: '0700000000' }),
      ).rejects.toThrow(/préfixe/i);
    });

    it.each([
      ['AIRTEL', '0970000000'],
      ['AIRTEL_COD', '0250000000'],
      ['ORANGE', '0890000000'],
      ['AFRIMONEY', '0900000000'],
      ['VODACOM_MPESA_COD', '+243 82 000 0000'],
    ])('accepte %s avec %s', async (operator, phoneNumber) => {
      mockToken();
      fetchMock.mockResolvedValueOnce(pending());
      await expect(
        provider.initPayment({ ...payment, operator, phoneNumber }),
      ).resolves.toEqual({ paymentRef: payment.paymentRef });
    });

    it('lève une erreur si Araka refuse la création (HTTP 400)', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(
        fakeResponse(
          { responseCode: '400', responseDescription: 'Bad Request', data: {} },
          400,
        ),
      );
      await expect(provider.initPayment(payment)).rejects.toThrow(/Araka/);
    });

    it('exige une URL de callback https', async () => {
      env.API_BASE_URL = 'http://localhost:3000';
      build();
      await expect(provider.initPayment(payment)).rejects.toThrow(/https/);
    });

    it('signale une configuration incomplète sans appeler Araka', async () => {
      env.ARAKA_SECRET_KEY = undefined;
      build();
      await expect(provider.initPayment(payment)).rejects.toThrow(
        /ARAKA_SECRET_KEY/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('checkStatus', () => {
    function status(httpStatus: number, statusName: string) {
      return fakeResponse(
        {
          responseCode: String(httpStatus),
          responseDescription: statusName,
          data: {
            externalReference: payment.paymentRef,
            status: statusName,
            amount: 12.5,
            currency: 'USD',
          },
        },
        httpStatus,
      );
    }

    it('Approved → APPROVED avec montant et devise', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(status(200, 'Approved'));
      await expect(provider.checkStatus(payment.paymentRef)).resolves.toEqual({
        status: 'APPROVED',
        amount: 12.5,
        currency: 'USD',
      });
      expect(fetchMock.mock.calls[1][0]).toBe(
        `https://araka.test/v1/reporting/getstatusbyexternalreference/${payment.paymentRef}`,
      );
    });

    it('Pending (201) → PENDING', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(status(201, 'Pending'));
      const res = await provider.checkStatus(payment.paymentRef);
      expect(res.status).toBe('PENDING');
    });

    it('Declined (422) → DECLINED, sans lever d’erreur', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(status(422, 'Declined'));
      const res = await provider.checkStatus(payment.paymentRef);
      expect(res.status).toBe('DECLINED');
    });

    it('404 → PENDING (transaction pas encore visible)', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(fakeResponse({}, 404));
      const res = await provider.checkStatus(payment.paymentRef);
      expect(res).toEqual({ status: 'PENDING' });
    });

    it('erreur serveur → lève (le reaper réessaiera)', async () => {
      mockToken();
      fetchMock.mockResolvedValueOnce(fakeResponse({}, 502));
      await expect(provider.checkStatus(payment.paymentRef)).rejects.toThrow();
    });
  });

  describe('verifyWebhookSignature', () => {
    // Vecteur de test publié dans la documentation Araka v1.
    const DOC_BODY =
      '{"responseCode":"200","responseDescription":"Approved","data":{"systemReference":"TXN-1097c3fee6b94b5cb50bbaeeeca75817","externalReference":"AIRTIME-ORDER-0001","statusName":"Approved","amount":5.00,"currency":"USD","providerReference":"AIR-REF-445566","deliveredAtUtc":"2026-04-30T11:00:08.0000000+00:00"}}';
    const DOC_SIGNATURE = 'AiYVZ1RNnqiQDikVwDIaaS8lyWo0fQE8ldow9RIOLPI=';
    const now = () => String(Math.floor(Date.now() / 1000));
    let nonceSeq = 0;
    const nonce = () => (++nonceSeq).toString(16).padStart(32, '0');

    function headers(sig = DOC_SIGNATURE, ts = now(), n = nonce()) {
      return {
        'x-api-signature': sig,
        'x-api-timestamp': ts,
        'x-api-nonce': n,
      };
    }

    it('accepte le vecteur officiel de la documentation', () => {
      expect(provider.verifyWebhookSignature(DOC_BODY, headers())).toBe(true);
    });

    it('accepte des noms d’en-têtes en casse quelconque', () => {
      expect(
        provider.verifyWebhookSignature(DOC_BODY, {
          'X-API-Signature': DOC_SIGNATURE,
          'X-API-Timestamp': now(),
          'X-API-Nonce': nonce(),
        }),
      ).toBe(true);
    });

    it('rejette un corps modifié', () => {
      const tampered = DOC_BODY.replace('5.00', '500.00');
      expect(provider.verifyWebhookSignature(tampered, headers())).toBe(false);
    });

    it('rejette une signature absente ou mal formée', () => {
      expect(provider.verifyWebhookSignature(DOC_BODY, headers(''))).toBe(
        false,
      );
      expect(
        provider.verifyWebhookSignature(DOC_BODY, headers('pas-du-base64!')),
      ).toBe(false);
    });

    it('rejette un horodatage de plus de 5 minutes ou absent', () => {
      const old = String(Math.floor(Date.now() / 1000) - 6 * 60);
      expect(
        provider.verifyWebhookSignature(DOC_BODY, headers(DOC_SIGNATURE, old)),
      ).toBe(false);
      expect(
        provider.verifyWebhookSignature(DOC_BODY, headers(DOC_SIGNATURE, '')),
      ).toBe(false);
    });

    it('rejette un nonce déjà vu (rejeu)', () => {
      const h = headers();
      expect(provider.verifyWebhookSignature(DOC_BODY, h)).toBe(true);
      expect(provider.verifyWebhookSignature(DOC_BODY, h)).toBe(false);
    });

    it('rejette tout callback si ARAKA_WEBHOOK_SECRET est absent (fail-closed)', () => {
      env.ARAKA_WEBHOOK_SECRET = undefined;
      build();
      expect(provider.verifyWebhookSignature(DOC_BODY, headers())).toBe(false);
    });

    it('accepte une signature calculée avec un autre secret configuré', () => {
      env.ARAKA_WEBHOOK_SECRET = 'whsec_autre';
      build();
      const body = '{"data":{"externalReference":"x"}}';
      const sig = createHmac('sha256', 'whsec_autre')
        .update(body, 'utf8')
        .digest('base64');
      expect(provider.verifyWebhookSignature(body, headers(sig))).toBe(true);
    });
  });

  it('getOperators expose les 4 opérateurs RDC', async () => {
    const ops = await provider.getOperators();
    expect(ops.map((o) => o.code)).toEqual([
      'MPESA',
      'AIRTEL',
      'ORANGE',
      'AFRIMONEY',
    ]);
  });
});
