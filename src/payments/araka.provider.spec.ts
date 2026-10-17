import { ArakaProvider } from './araka.provider';
import { PrismaService } from 'src/prisma/prisma.service';
import { InitPaymentInput } from './payment-provider.interface';

function fakeResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('ArakaProvider', () => {
  let provider: ArakaProvider;
  let fetchMock: jest.Mock;
  const prisma = {
    paymentProviderLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const payment: InitPaymentInput = {
    paymentRef: '11111111-1111-4111-8111-111111111111',
    amount: 12.5,
    currency: 'USD',
    operator: 'MPESA',
    phoneNumber: '0810000000',
    redirectUrl: 'https://api.vybe.test/payments/webhook',
    customerFullName: 'Ada Lovelace',
    customerEmail: 'ada@vybe.test',
  };

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) =>
        ({
          ARAKA_BASE_URL: 'https://araka.test',
          ARAKA_EMAIL: 'merchant@vybe.test',
          ARAKA_PASSWORD: 'secret',
          ARAKA_PAYMENT_PAGE_ID: 'page-1',
          API_BASE_URL: 'https://api.vybe.test',
        })[key],
      ),
    };
    provider = new ArakaProvider(
      config as never,
      prisma as unknown as PrismaService,
    );
    fetchMock = jest.fn();
    global.fetch = fetchMock as never;
    prisma.paymentProviderLog.create.mockClear();
  });

  function mockLogin() {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ token: 'tok-1', expiresIn: 7200 }),
    );
  }

  it('login puis paymentrequest Mobile Money, MSISDN normalisé, sans rappeler le login', async () => {
    mockLogin();
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        originatingTransactionId: payment.paymentRef,
        statusCode: '202',
        statusDescription: 'Accepted',
        transactionId: '99',
      }),
    );
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        originatingTransactionId: payment.paymentRef,
        statusCode: '202',
      }),
    );

    const first = await provider.initPayment(payment);
    const second = await provider.initPayment({
      ...payment,
      paymentRef: '22222222-2222-4222-8222-222222222222',
    });

    expect(first).toEqual({ paymentRef: payment.paymentRef });
    expect(second.paymentUrl).toBeUndefined();
    // Un seul login pour les deux initiations (jeton mis en cache).
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const login = fetchMock.mock.calls[0];
    expect(login[0]).toBe('https://araka.test/api/login');
    expect(JSON.parse(login[1].body)).toEqual({
      emailAddress: 'merchant@vybe.test',
      password: 'secret',
    });

    const req = fetchMock.mock.calls[1];
    expect(req[0]).toBe('https://araka.test/api/pay/paymentrequest');
    expect(req[1].headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(req[1].body);
    expect(body.order).toEqual(
      expect.objectContaining({
        paymentPageId: 'page-1',
        transactionReference: payment.paymentRef,
        amount: 12.5,
        currency: 'USD',
        customerFullName: 'Ada Lovelace',
        redirectURL: 'https://api.vybe.test/payments/webhook',
      }),
    );
    expect(body.paymentChannel).toEqual({
      channel: 'MOBILEMONEY',
      provider: 'MPESA',
      walletId: '243810000000',
      walletID: '243810000000',
    });
  });

  it('alias PawaPay + montant CDF entier + page de paiement renvoyée', async () => {
    mockLogin();
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        statusCode: '202',
        paymentPage: 'https://pay.araka.test/checkout/abc',
      }),
    );

    const res = await provider.initPayment({
      ...payment,
      operator: 'VODACOM_MPESA_COD',
      amount: 42000.4,
      currency: 'CDF',
      customerFullName: undefined,
    });

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.paymentChannel.provider).toBe('MPESA');
    expect(body.order.amount).toBe(42000);
    expect(body.order.customerFullName).toBe('Client Vybe');
    expect(res.paymentUrl).toBe('https://pay.araka.test/checkout/abc');
  });

  it('statusCode hors 200/202 → initiation refusée', async () => {
    mockLogin();
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ statusCode: '400', statusDescription: 'Declined' }),
    );
    await expect(provider.initPayment(payment)).rejects.toThrow(/refusé/);
  });

  it('opérateur ou numéro manquant → erreur avant tout appel', async () => {
    await expect(
      provider.initPayment({ ...payment, operator: undefined }),
    ).rejects.toThrow(/requis/);
    await expect(
      provider.initPayment({ ...payment, phoneNumber: undefined }),
    ).rejects.toThrow(/requis/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('configuration incomplète → erreur avant tout appel', async () => {
    const bare = new ArakaProvider(
      { get: () => undefined } as never,
      prisma as unknown as PrismaService,
    );
    await expect(bare.initPayment(payment)).rejects.toThrow(
      /Configuration Araka incomplète/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ statusCode: '200', status: 'APPROVED', amount: '12.5', currency: 'USD' }, 'APPROVED', 12.5],
    [{ statusCode: '202', status: 'PENDING' }, 'PENDING', undefined],
    [{ statusCode: '400', status: 'FAILED' }, 'DECLINED', undefined],
  ])('checkStatus %#', async (payload, expected, amount) => {
    mockLogin();
    fetchMock.mockResolvedValueOnce(fakeResponse(payload));
    const res = await provider.checkStatus(payment.paymentRef);
    expect(res.status).toBe(expected);
    expect(res.amount).toBe(amount);
    expect(fetchMock.mock.calls[1][0]).toBe(
      `https://araka.test/api/reporting/transactionstatusbyreference/${payment.paymentRef}`,
    );
  });

  // Araka enveloppe la réponse du reporting dans un tableau : [{ ... }].
  // L'init, elle, renvoie un objet nu — d'où le piège. On doit déballer.
  it('checkStatus déballe le tableau renvoyé par le reporting Araka', async () => {
    mockLogin();
    fetchMock.mockResolvedValueOnce(
      fakeResponse([
        { statusCode: '200', status: 'APPROVED', amount: '12.5', currency: 'USD' },
      ]),
    );
    const res = await provider.checkStatus(payment.paymentRef);
    expect(res.status).toBe('APPROVED');
    expect(res.amount).toBe(12.5);
    expect(res.currency).toBe('USD');
  });

  it('statut introuvable (404) → PENDING', async () => {
    mockLogin();
    fetchMock.mockResolvedValueOnce(fakeResponse({}, false, 404));
    await expect(provider.checkStatus(payment.paymentRef)).resolves.toEqual({
      status: 'PENDING',
    });
  });

  it('jeton 401 → un nouveau login puis nouvel essai', async () => {
    mockLogin();
    fetchMock.mockResolvedValueOnce(fakeResponse({ message: 'expired' }, false, 401));
    fetchMock.mockResolvedValueOnce(fakeResponse({ token: 'tok-2' }));
    fetchMock.mockResolvedValueOnce(fakeResponse({ statusCode: '202' }));

    await provider.initPayment(payment);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers.Authorization).toBe('Bearer tok-2');
  });

  it('webhook sans secret → accepté ; avec secret → comparaison du header', () => {
    expect(provider.verifyWebhookSignature('{}', {})).toBe(true);

    const secured = new ArakaProvider(
      {
        get: (key: string) =>
          ({
            ARAKA_BASE_URL: 'https://araka.test',
            ARAKA_EMAIL: 'merchant@vybe.test',
            ARAKA_PASSWORD: 'secret',
            ARAKA_PAYMENT_PAGE_ID: 'page-1',
            ARAKA_WEBHOOK_SECRET: 'whsec',
          })[key],
      } as never,
      prisma as unknown as PrismaService,
    );
    expect(secured.verifyWebhookSignature('{}', {})).toBe(false);
    expect(
      secured.verifyWebhookSignature('{}', { 'x-araka-secret': 'whsec' }),
    ).toBe(true);
    expect(
      secured.verifyWebhookSignature('{}', { 'X-Araka-Secret': 'nope' }),
    ).toBe(false);
  });

  it('getOperators expose les 4 réseaux Araka en USD et CDF', async () => {
    const ops = await provider.getOperators();
    expect(ops.map((o) => o.code)).toEqual([
      'MPESA',
      'AIRTEL',
      'ORANGE',
      'AFRIMONEY',
    ]);
    expect(ops.every((o) => o.available && o.currencies.includes('CDF'))).toBe(
      true,
    );
  });
});
