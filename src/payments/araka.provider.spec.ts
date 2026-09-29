import { createHmac } from 'crypto';
import { ArakaProvider } from './araka.provider';
import { ProviderDeclinedError } from './payment-provider.interface';

// Réponse fetch factice façon Response (le provider lit `text()`).
interface FakeResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

// Corps de requête factice tel qu'observé côté test (méthode/en-têtes/corps) :
// typé (plutôt que `any`) pour que la lecture de `fetchMock.mock.calls` reste
// vérifiée par le compilateur (pas de `no-unsafe-*`).
interface FakeRequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}

type FetchMock = jest.Mock<Promise<FakeResponse>, [string, FakeRequestInit]>;

function res(status: number, body?: unknown): FakeResponse {
  const text =
    body === undefined
      ? ''
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(text),
  };
}

// JWT non signé portant seulement `exp` (le provider ne vérifie pas la signature).
function jwtWithExp(expSeconds: number) {
  const b64 = (o: object) =>
    Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ exp: expSeconds })}.sig`;
}

const CONFIG: Record<string, string | undefined> = {
  ARAKA_BASE_URL: 'https://araka.test/api',
  ARAKA_EMAIL: 'api@vybe.test',
  ARAKA_PASSWORD: 'secret',
  ARAKA_PAYMENT_PAGE_ID: 'PAGE-1',
  ARAKA_CALLBACK_KEY: 'cb-key',
};

function makeProvider(over: Record<string, string | undefined> = {}) {
  const values = { ...CONFIG, ...over };
  return new ArakaProvider({ get: jest.fn((k: string) => values[k]) } as any);
}

const REF = 'VBAAAAAAAAAAAAAAAAAA';
const TOKEN = jwtWithExp(Math.floor(Date.now() / 1000) + 7200);
const loginOk = (token = TOKEN) =>
  res(200, { token, username: 'api@vybe.test' });

describe('ArakaProvider', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = jest.fn<Promise<FakeResponse>, [string, FakeRequestInit]>();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  describe('configuration', () => {
    it('V6 : ARAKA_BASE_URL en http:// → refus de démarrer', () => {
      expect(() =>
        makeProvider({ ARAKA_BASE_URL: 'http://araka.test/api' }),
      ).toThrow(/https/);
    });
  });

  describe('token', () => {
    it('login unique puis réutilisation du token', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(res(200, []));
      const p = makeProvider();
      await p.checkStatus(REF);
      await p.checkStatus(REF);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [loginUrl, loginOpts] = fetchMock.mock.calls[0];
      expect(loginUrl).toBe('https://araka.test/api/login');
      expect(JSON.parse(loginOpts.body)).toEqual({
        emailAddress: 'api@vybe.test',
        password: 'secret',
      });
      expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe(
        `Bearer ${TOKEN}`,
      );
    });

    it('re-login quand le token est à moins de 60 s de son expiration', async () => {
      const soon = jwtWithExp(Math.floor(Date.now() / 1000) + 30);
      fetchMock
        .mockResolvedValueOnce(loginOk(soon))
        .mockResolvedValueOnce(res(200, []))
        .mockResolvedValueOnce(loginOk(soon))
        .mockResolvedValueOnce(res(200, []));
      const p = makeProvider();
      await p.checkStatus(REF);
      await p.checkStatus(REF);

      const urls = fetchMock.mock.calls.map((c) => c[0]);
      expect(urls.filter((u) => u.endsWith('/login'))).toHaveLength(2);
    });

    it('401 → re-login + un seul nouvel essai', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(401))
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, []));
      await expect(makeProvider().checkStatus(REF)).resolves.toEqual({
        status: 'PENDING',
      });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('401 deux fois → exception', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(401))
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(401));
      await expect(makeProvider().checkStatus(REF)).rejects.toThrow(
        /authentification/,
      );
    });

    it('login refusé → exception', async () => {
      fetchMock.mockResolvedValueOnce(res(401));
      await expect(makeProvider().checkStatus(REF)).rejects.toThrow(/login/);
    });
  });

  describe('initPayment', () => {
    const input = {
      paymentRef: REF,
      amount: 2500,
      currency: 'CDF' as const,
      operator: 'MPESA',
      phoneNumber: '243810000001',
      redirectUrl: 'https://api.vybe.test/payments/webhook',
    };

    it('POST /pay/paymentrequest : corps ARAKA exact + mode de callback HMAC', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(
        res(200, {
          transactionId: '128338',
          originatingTransactionId: REF,
          statusCode: '202',
          statusDescription: 'ACCEPTED',
        }),
      );
      const result = await makeProvider().initPayment(input);

      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toBe('https://araka.test/api/pay/paymentrequest');
      expect(opts.method).toBe('POST');
      expect(opts.headers['X-API-CALLBACK-MODE']).toBe('2');
      expect(JSON.parse(opts.body)).toEqual({
        order: {
          paymentPageId: 'PAGE-1',
          transactionReference: REF,
          amount: 2500,
          currency: 'CDF',
          redirectURL: 'https://api.vybe.test/payments/webhook',
        },
        paymentChannel: {
          channel: 'MOBILEMONEY',
          provider: 'MPESA',
          walletID: '+243810000001',
        },
      });
      expect(result).toEqual({ paymentRef: REF, providerTxnId: '128338' });
    });

    it('HTTP 400 → ProviderDeclinedError', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(
          res(400, { statusCode: '400', statusDescription: 'DECLINED' }),
        );
      await expect(makeProvider().initPayment(input)).rejects.toBeInstanceOf(
        ProviderDeclinedError,
      );
    });

    it('HTTP 200 mais statusCode 400 / DECLINED → ProviderDeclinedError', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(
          res(200, { statusCode: '400', statusDescription: 'DECLINED' }),
        );
      await expect(makeProvider().initPayment(input)).rejects.toBeInstanceOf(
        ProviderDeclinedError,
      );
    });

    it('HTTP 500 → exception ordinaire (issue inconnue, PAS un refus)', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(500));
      const err = await makeProvider()
        .initPayment(input)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(ProviderDeclinedError);
    });

    it('timeout réseau → exception ordinaire (PAS un refus)', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockRejectedValueOnce(new DOMException('timeout', 'TimeoutError'));
      const err = await makeProvider()
        .initPayment(input)
        .catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(ProviderDeclinedError);
    });
  });

  describe('checkStatus (transactionstatusbyreference)', () => {
    const item = (status: string, ref = REF) => ({
      transactionId: '1',
      status,
      transactionReference: ref,
      originatingTransactionId: ref,
    });

    it('interroge /reporting/transactionstatusbyreference/{ref}', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, []));
      await makeProvider().checkStatus(REF);
      expect(fetchMock.mock.calls[1][0]).toBe(
        `https://araka.test/api/reporting/transactionstatusbyreference/${REF}`,
      );
    });

    it.each([
      ['tableau vide', 200, [], { status: 'PENDING' }],
      [
        'un APPROVED',
        200,
        [item('APPROVED')],
        { status: 'APPROVED', approvedCount: 1 },
      ],
      [
        'deux APPROVED (double débit)',
        200,
        [item('APPROVED'), item('APPROVED')],
        { status: 'APPROVED', approvedCount: 2 },
      ],
      [
        'tous DECLINED',
        200,
        [item('DECLINED'), item('DECLINED')],
        { status: 'DECLINED' },
      ],
      [
        'DECLINED + ACCEPTED',
        200,
        [item('DECLINED'), item('ACCEPTED')],
        { status: 'PENDING' },
      ],
      ['ACCEPTED seul', 200, [item('ACCEPTED')], { status: 'PENDING' }],
      ['statut inconnu', 200, [item('WHATEVER')], { status: 'PENDING' }],
      [
        'objet unique (format du manuel, statusDescription)',
        200,
        { originatingTransactionId: REF, statusDescription: 'APPROVED' },
        { status: 'APPROVED', approvedCount: 1 },
      ],
      [
        'V5 : référence différente ignorée',
        200,
        [item('APPROVED', 'AUTRE')],
        { status: 'PENDING' },
      ],
      ['404 (référence inconnue)', 404, undefined, { status: 'PENDING' }],
    ])('%s', async (_label, httpStatus, body, expected) => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(httpStatus, body));
      await expect(makeProvider().checkStatus(REF)).resolves.toEqual(expected);
    });

    it('HTTP 500 → exception (statut inconnu, jamais DECLINED)', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(500));
      await expect(makeProvider().checkStatus(REF)).rejects.toThrow(
        /indisponible/,
      );
    });

    it('checkPayoutStatus applique les mêmes règles', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(200, [item('APPROVED')]));
      await expect(makeProvider().checkPayoutStatus(REF)).resolves.toEqual({
        status: 'APPROVED',
        approvedCount: 1,
      });
    });
  });

  describe('verifyWebhookSignature (HMAC-SHA256 base64, X-APP-SIGNATURE)', () => {
    const body = JSON.stringify({
      originatingTransactionId: REF,
      statusDescription: 'APPROVED',
    });
    const sign = (raw: string, key = 'cb-key') =>
      createHmac('sha256', key).update(raw, 'utf8').digest('base64');

    it('signature valide → true', () => {
      expect(
        makeProvider().verifyWebhookSignature(body, {
          'x-app-signature': sign(body),
        }),
      ).toBe(true);
    });
    it('corps altéré → false', () => {
      expect(
        makeProvider().verifyWebhookSignature(body + ' ', {
          'x-app-signature': sign(body),
        }),
      ).toBe(false);
    });
    it('mauvaise clé → false', () => {
      expect(
        makeProvider().verifyWebhookSignature(body, {
          'x-app-signature': sign(body, 'autre'),
        }),
      ).toBe(false);
    });
    it('header absent → false', () => {
      expect(makeProvider().verifyWebhookSignature(body, {})).toBe(false);
    });
    it('signature de longueur différente → false (pas d’exception)', () => {
      expect(
        makeProvider().verifyWebhookSignature(body, {
          'x-app-signature': 'AAAA',
        }),
      ).toBe(false);
    });
    it('clé non configurée → false (fail-closed)', () => {
      expect(
        makeProvider({ ARAKA_CALLBACK_KEY: undefined }).verifyWebhookSignature(
          body,
          {
            'x-app-signature': sign(body),
          },
        ),
      ).toBe(false);
    });
  });

  describe('extraction de référence du callback', () => {
    it('originatingTransactionId présent', () => {
      const raw = JSON.stringify({
        transactionId: '1',
        originatingTransactionId: REF,
      });
      expect(makeProvider().extractPaymentRef(raw)).toBe(REF);
      expect(makeProvider().extractPayoutRef(raw)).toBe(REF);
    });
    it('champ absent → undefined', () => {
      expect(
        makeProvider().extractPaymentRef('{"transactionId":"1"}'),
      ).toBeUndefined();
    });
    it('JSON illisible → undefined', () => {
      expect(makeProvider().extractPaymentRef('pas-du-json')).toBeUndefined();
    });
  });

  describe('getOperators', () => {
    it('liste fixe USD+CDF, AFRIMONEY sans retrait, préfixes exposés', async () => {
      const ops = await makeProvider().getOperators();
      expect(ops.map((o) => o.code)).toEqual([
        'MPESA',
        'ORANGE',
        'AIRTEL',
        'AFRIMONEY',
      ]);
      for (const o of ops) {
        expect(o.available).toBe(true);
        expect(o.currencies).toEqual(['USD', 'CDF']);
      }
      expect(ops.find((o) => o.code === 'AFRIMONEY')!.payoutAvailable).toBe(
        false,
      );
      expect(ops.find((o) => o.code === 'MPESA')!.payoutAvailable).toBe(true);
      expect(ops.find((o) => o.code === 'MPESA')!.phonePrefixes).toEqual([
        '81',
        '82',
        '83',
      ]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('V7 : ARAKA_DISABLED_OPERATORS grise les opérateurs listés', async () => {
      const ops = await makeProvider({
        ARAKA_DISABLED_OPERATORS: ' orange, AIRTEL ',
      }).getOperators();
      const orange = ops.find((o) => o.code === 'ORANGE')!;
      expect(orange).toEqual(
        expect.objectContaining({
          available: false,
          currencies: [],
          payoutAvailable: false,
        }),
      );
      expect(ops.find((o) => o.code === 'AIRTEL')!.available).toBe(false);
      expect(ops.find((o) => o.code === 'MPESA')!.available).toBe(true);
    });
  });

  describe('initPayout (sendmobilemoney)', () => {
    const input = {
      payoutRef: REF,
      amount: 50,
      currency: 'USD' as const,
      operator: 'MPESA',
      phoneNumber: '243810000001',
    };

    it('200 SUCCESS → ACCEPTED (le reaper confirmera), corps exact', async () => {
      fetchMock.mockResolvedValueOnce(loginOk()).mockResolvedValueOnce(
        res(200, {
          transactionId: '999',
          originatingTransactionId: REF,
          statusCode: '200',
          statusDescription: 'SUCCESS',
        }),
      );
      const result = await makeProvider().initPayout(input);

      const [url, opts] = fetchMock.mock.calls[1];
      expect(url).toBe('https://araka.test/api/pay/sendmobilemoney');
      expect(JSON.parse(opts.body)).toEqual({
        order: { transactionReference: REF, amount: 50, currency: 'USD' },
        destination: { provider: 'MPESA', walletID: '+243810000001' },
      });
      expect(result).toEqual({
        payoutRef: REF,
        providerPayoutId: '999',
        status: 'ACCEPTED',
      });
    });

    it('HTTP 400 → DECLINED', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(400, {}));
      await expect(makeProvider().initPayout(input)).resolves.toEqual(
        expect.objectContaining({ status: 'DECLINED' }),
      );
    });

    it('HTTP 500 → exception (le payout reste PENDING côté service)', async () => {
      fetchMock
        .mockResolvedValueOnce(loginOk())
        .mockResolvedValueOnce(res(500));
      await expect(makeProvider().initPayout(input)).rejects.toThrow();
    });

    it('AFRIMONEY (pas de retrait) → DECLINED sans aucun appel réseau', async () => {
      await expect(
        makeProvider().initPayout({ ...input, operator: 'AFRIMONEY' }),
      ).resolves.toEqual({ payoutRef: REF, status: 'DECLINED' });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
