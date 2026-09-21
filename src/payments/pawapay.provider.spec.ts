import {
  createHash,
  generateKeyPairSync,
  KeyObject,
  sign as cryptoSign,
} from 'crypto';
import { PawaPayProvider } from './pawapay.provider';
import { InitPaymentInput } from './payment-provider.interface';

// Réponse fetch factice (json + text + ok/status), façon Response.
function fakeResponse(body: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as any;
}

describe('PawaPayProvider.initPayment', () => {
  let provider: PawaPayProvider;
  let config: any;
  let prisma: any;
  let fetchMock: jest.Mock;

  const baseInput: InitPaymentInput = {
    paymentRef: 'f4401bd2-1568-4140-bf2d-eb77d2b2b639',
    amount: 15,
    currency: 'USD',
    operator: 'VODACOM_MPESA_COD',
    phoneNumber: '243810000000',
  };

  beforeEach(() => {
    config = {
      get: jest.fn((key: string) =>
        ({
          PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
          PAWAPAY_API_TOKEN: 'sandbox-token',
        })[key],
      ),
    };
    prisma = { paymentProviderLog: { create: jest.fn().mockResolvedValue({}) } };
    provider = new PawaPayProvider(config, prisma);

    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('POST /v2/deposits avec bearer + corps PawaPay, renvoie paymentRef sans paymentUrl', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        depositId: baseInput.paymentRef,
        status: 'ACCEPTED',
        created: '2026-09-13T10:00:00Z',
      }),
    );

    const res = await provider.initPayment(baseInput);

    // Appel HTTP
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sandbox.pawapay.io/v2/deposits');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer sandbox-token');
    expect(opts.headers['Content-Type']).toBe('application/json');

    // Corps conforme au schéma PawaPay
    const body = JSON.parse(opts.body);
    expect(body.depositId).toBe(baseInput.paymentRef);
    expect(body.payer.type).toBe('MMO');
    expect(body.payer.accountDetails.provider).toBe('VODACOM_MPESA_COD');
    expect(body.payer.accountDetails.phoneNumber).toBe('243810000000');
    expect(body.amount).toBe('15'); // string
    expect(body.currency).toBe('USD');

    // Push = pas de paymentUrl ; paymentRef renvoyé
    expect(res.paymentRef).toBe(baseInput.paymentRef);
    expect(res.paymentUrl).toBeUndefined();

    // Audit
    expect(prisma.paymentProviderLog.create).toHaveBeenCalledTimes(1);
    const logged = prisma.paymentProviderLog.create.mock.calls[0][0].data;
    expect(logged.paymentRef).toBe(baseInput.paymentRef);
    expect(logged.direction).toBe('INIT');
    expect(logged.status).toBe('ACCEPTED');
  });

  it('CDF : montant envoyé en entier (string)', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ depositId: baseInput.paymentRef, status: 'ACCEPTED' }),
    );

    await provider.initPayment({ ...baseInput, amount: 42000.4, currency: 'CDF' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.amount).toBe('42000');
    expect(body.currency).toBe('CDF');
  });

  it('DUPLICATE_IGNORED est traité comme un succès (idempotence)', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        depositId: baseInput.paymentRef,
        status: 'DUPLICATE_IGNORED',
      }),
    );

    const res = await provider.initPayment(baseInput);
    expect(res.paymentRef).toBe(baseInput.paymentRef);
  });

  it('REJECTED → lève une erreur (createOrder marquera FAILED)', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        depositId: baseInput.paymentRef,
        status: 'REJECTED',
        failureReason: {
          failureCode: 'INVALID_PHONE_NUMBER',
          failureMessage: 'invalide',
        },
      }),
    );

    await expect(provider.initPayment(baseInput)).rejects.toThrow();
    // Le refus est tout de même audité
    expect(prisma.paymentProviderLog.create).toHaveBeenCalled();
  });

  it('HTTP non-2xx → lève une erreur', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ message: 'nope' }, false, 500));
    await expect(provider.initPayment(baseInput)).rejects.toThrow();
  });

  it('operator/phoneNumber manquants → erreur AVANT tout appel réseau', async () => {
    await expect(
      provider.initPayment({ ...baseInput, operator: undefined }),
    ).rejects.toThrow();
    await expect(
      provider.initPayment({ ...baseInput, phoneNumber: undefined }),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('PawaPayProvider.checkStatus', () => {
  let provider: PawaPayProvider;
  let prisma: any;
  let fetchMock: jest.Mock;
  const ref = 'f4401bd2-1568-4140-bf2d-eb77d2b2b639';

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) =>
        ({
          PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
          PAWAPAY_API_TOKEN: 'sandbox-token',
        })[key],
      ),
    };
    prisma = { paymentProviderLog: { create: jest.fn().mockResolvedValue({}) } };
    provider = new PawaPayProvider(config as any, prisma);
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('GET /v2/deposits/:id avec bearer ; COMPLETED → APPROVED + montant/devise', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 'FOUND',
        data: {
          depositId: ref,
          status: 'COMPLETED',
          amount: '15',
          currency: 'USD',
          providerTransactionId: 'MMO-123',
        },
      }),
    );

    const res = await provider.checkStatus(ref);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.sandbox.pawapay.io/v2/deposits/${ref}`);
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer sandbox-token');

    expect(res.status).toBe('APPROVED');
    expect(res.amount).toBe(15);
    expect(res.currency).toBe('USD');

    expect(prisma.paymentProviderLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.paymentProviderLog.create.mock.calls[0][0].data.direction).toBe(
      'CHECK',
    );
  });

  it('FAILED → DECLINED', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ status: 'FOUND', data: { depositId: ref, status: 'FAILED' } }),
    );
    const res = await provider.checkStatus(ref);
    expect(res.status).toBe('DECLINED');
  });

  it('PROCESSING → PENDING', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 'FOUND',
        data: { depositId: ref, status: 'PROCESSING' },
      }),
    );
    const res = await provider.checkStatus(ref);
    expect(res.status).toBe('PENDING');
  });

  it('NOT_FOUND → PENDING (paiement pas encore connu)', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 'NOT_FOUND' }));
    const res = await provider.checkStatus(ref);
    expect(res.status).toBe('PENDING');
  });

  it('HTTP non-2xx → lève une erreur', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ message: 'boom' }, false, 500));
    await expect(provider.checkStatus(ref)).rejects.toThrow();
  });
});

describe('PawaPayProvider.verifyWebhookSignature', () => {
  let provider: PawaPayProvider;
  let privateKey: KeyObject;
  let publicPem: string;

  // Fabrique un callback signé RFC-9421 (ecdsa-p256-sha256) comme PawaPay :
  // Content-Digest (sha-512 du corps) + Signature-Input + Signature, la base de
  // signature couvrant ("content-digest").
  function signedCallback(rawBody: string) {
    const digest =
      'sha-512=:' +
      createHash('sha512').update(rawBody).digest('base64') +
      ':';
    const params =
      '("content-digest");created=1700000000;keyid="test-key";alg="ecdsa-p256-sha256"';
    const base =
      `"content-digest": ${digest}\n` + `"@signature-params": ${params}`;
    const sig = cryptoSign('sha256', Buffer.from(base), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    return {
      'content-digest': digest,
      'signature-input': `sig1=${params}`,
      signature: `sig1=:${sig}:`,
    };
  }

  // Variante PRODUCTION : la base de signature couvre aussi les composants DÉRIVÉS
  // @method / @path / @authority (en plus de content-digest), comme PawaPay en prod.
  function signedCallbackProd(
    rawBody: string,
    ctx: { method: string; path: string; authority: string },
  ) {
    const digest =
      'sha-512=:' + createHash('sha512').update(rawBody).digest('base64') + ':';
    const params =
      '("@method" "@path" "@authority" "content-digest");created=1700000000;keyid="test-key";alg="ecdsa-p256-sha256"';
    const base =
      `"@method": ${ctx.method.toUpperCase()}\n` +
      `"@path": ${ctx.path}\n` +
      `"@authority": ${ctx.authority.toLowerCase()}\n` +
      `"content-digest": ${digest}\n` +
      `"@signature-params": ${params}`;
    const sig = cryptoSign('sha256', Buffer.from(base), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64');
    return {
      'content-digest': digest,
      'signature-input': `sig1=${params}`,
      signature: `sig1=:${sig}:`,
    };
  }

  beforeEach(() => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = pair.privateKey;
    publicPem = pair.publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString();

    const config = {
      get: jest.fn((key: string) =>
        ({ PAWAPAY_PUBLIC_KEY: publicPem })[key],
      ),
    };
    const prisma = { paymentProviderLog: { create: jest.fn() } };
    provider = new PawaPayProvider(config as any, prisma);
  });

  it('callback authentique → true', () => {
    const body = JSON.stringify({ depositId: 'abc', status: 'COMPLETED' });
    expect(provider.verifyWebhookSignature(body, signedCallback(body))).toBe(true);
  });

  it('corps altéré (digest ne correspond plus) → false', () => {
    const body = JSON.stringify({ depositId: 'abc', status: 'COMPLETED' });
    const headers = signedCallback(body);
    const tampered = JSON.stringify({ depositId: 'abc', status: 'FAILED' });
    expect(provider.verifyWebhookSignature(tampered, headers)).toBe(false);
  });

  it('signature falsifiée → false', () => {
    const body = JSON.stringify({ depositId: 'abc', status: 'COMPLETED' });
    const headers = signedCallback(body);
    headers.signature = 'sig1=:AAAABBBBCCCCDDDD:';
    expect(provider.verifyWebhookSignature(body, headers)).toBe(false);
  });

  it('signée par une AUTRE clé → false', () => {
    const body = JSON.stringify({ depositId: 'abc', status: 'COMPLETED' });
    const headers = signedCallback(body);
    // On remplace la clé publique attendue par une clé étrangère.
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const config = { get: jest.fn(() => other) };
    const p = new PawaPayProvider(config as any, {
      paymentProviderLog: { create: jest.fn() },
    } as any);
    expect(p.verifyWebhookSignature(body, headers)).toBe(false);
  });

  it('clé publique absente en config → false (fail-closed)', () => {
    const config = { get: jest.fn(() => undefined) };
    const p = new PawaPayProvider(config as any, {
      paymentProviderLog: { create: jest.fn() },
    } as any);
    const body = '{}';
    expect(p.verifyWebhookSignature(body, signedCallback(body))).toBe(false);
  });

  it('headers de signature manquants → false', () => {
    expect(provider.verifyWebhookSignature('{}', {})).toBe(false);
  });

  const prodCtx = {
    method: 'POST',
    path: '/payments/webhook',
    authority: 'api.vybeplatform.app',
  };

  it('callback PROD (@method/@path/@authority) + contexte correct → true', () => {
    const body = JSON.stringify({ depositId: 'abc', status: 'COMPLETED' });
    const headers = signedCallbackProd(body, prodCtx);
    expect(provider.verifyWebhookSignature(body, headers, prodCtx)).toBe(true);
  });

  it('composants dérivés mais contexte incohérent (path ≠) → false', () => {
    const body = JSON.stringify({ depositId: 'abc', status: 'COMPLETED' });
    const headers = signedCallbackProd(body, prodCtx);
    expect(
      provider.verifyWebhookSignature(body, headers, { ...prodCtx, path: '/autre' }),
    ).toBe(false);
  });

  it('composants dérivés mais AUCUN contexte fourni → false (fail-closed)', () => {
    const body = JSON.stringify({ depositId: 'abc', status: 'COMPLETED' });
    const headers = signedCallbackProd(body, prodCtx);
    expect(provider.verifyWebhookSignature(body, headers)).toBe(false);
  });
});

describe('PawaPayProvider.initPayout', () => {
  let provider: PawaPayProvider;
  let prisma: any;
  let fetchMock: jest.Mock;

  const basePayout = {
    payoutRef: 'ref-1',
    amount: 45000,
    currency: 'CDF' as const,
    operator: 'VODACOM_MPESA_COD',
    phoneNumber: '243812345678',
  };

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) =>
        ({
          PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
          PAWAPAY_API_TOKEN: 'sandbox-token',
        })[key],
      ),
    };
    prisma = { paymentProviderLog: { create: jest.fn().mockResolvedValue({}) } };
    provider = new PawaPayProvider(config as any, prisma);
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('POST /v2/payouts (CDF entier) → ACCEPTED → status PENDING normalisé', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ payoutId: 'ref-1', status: 'ACCEPTED' }),
    );

    const res = await provider.initPayout(basePayout);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sandbox.pawapay.io/v2/payouts');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer sandbox-token');

    const body = JSON.parse(opts.body);
    expect(body.payoutId).toBe('ref-1');
    expect(body.amount).toBe('45000'); // CDF entier, string
    expect(body.recipient.type).toBe('MMO');
    expect(body.recipient.accountDetails.phoneNumber).toBe('243812345678');
    expect(body.recipient.accountDetails.provider).toBe('VODACOM_MPESA_COD');

    expect(res.status).toBe('PENDING');
    expect(res.payoutRef).toBe('ref-1');
    expect(res.providerPayoutId).toBe('ref-1');

    expect(prisma.paymentProviderLog.create).toHaveBeenCalledTimes(1);
    const logged = prisma.paymentProviderLog.create.mock.calls[0][0].data;
    expect(logged.paymentRef).toBe('ref-1');
    expect(logged.direction).toBe('PAYOUT_INIT');
    expect(logged.status).toBe('ACCEPTED');
  });

  it('REJECTED → status DECLINED', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({ payoutId: 'ref-2', status: 'REJECTED' }),
    );

    const res = await provider.initPayout({ ...basePayout, payoutRef: 'ref-2', amount: 1000 });
    expect(res.status).toBe('DECLINED');
  });

  it('HTTP non-2xx → lève une erreur', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ message: 'nope' }, false, 500));
    await expect(provider.initPayout(basePayout)).rejects.toThrow();
  });
});

describe('PawaPayProvider.checkPayoutStatus', () => {
  let provider: PawaPayProvider;
  let prisma: any;
  let fetchMock: jest.Mock;
  const ref = 'ref-1';

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) =>
        ({
          PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
          PAWAPAY_API_TOKEN: 'sandbox-token',
        })[key],
      ),
    };
    prisma = { paymentProviderLog: { create: jest.fn().mockResolvedValue({}) } };
    provider = new PawaPayProvider(config as any, prisma);
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('GET /v2/payouts/{id} FOUND/COMPLETED → APPROVED + montant', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 'FOUND',
        data: { payoutId: ref, status: 'COMPLETED', amount: '45000', currency: 'CDF' },
      }),
    );

    const res = await provider.checkPayoutStatus(ref);

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.sandbox.pawapay.io/v2/payouts/${ref}`);
    expect(opts.method).toBe('GET');
    expect(opts.headers.Authorization).toBe('Bearer sandbox-token');

    expect(res.status).toBe('APPROVED');
    expect(res.amount).toBe(45000);
    expect(res.currency).toBe('CDF');

    expect(prisma.paymentProviderLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.paymentProviderLog.create.mock.calls[0][0].data.direction).toBe(
      'PAYOUT_CHECK',
    );
  });

  it('NOT_FOUND → PENDING (payout pas encore connu)', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ status: 'NOT_FOUND' }));
    const res = await provider.checkPayoutStatus(ref);
    expect(res.status).toBe('PENDING');
  });

  it('HTTP non-2xx → lève une erreur', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ message: 'boom' }, false, 500));
    await expect(provider.checkPayoutStatus(ref)).rejects.toThrow();
  });
});

describe('PawaPayProvider.getOperators', () => {
  let provider: PawaPayProvider;
  let prisma: any;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) =>
        ({
          PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
          PAWAPAY_API_TOKEN: 'sandbox-token',
        })[key],
      ),
    };
    prisma = { paymentProviderLog: { create: jest.fn().mockResolvedValue({}) } };
    provider = new PawaPayProvider(config as any, prisma);
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('GET /v2/active-conf : mappe les providers RDC (COD) avec dispo par statut DEPOSIT', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        companyName: 'Vybe',
        countries: [
          {
            country: 'COD',
            providers: [
              {
                provider: 'VODACOM_MPESA_COD',
                displayName: 'Vodacom M-Pesa',
                logo: 'https://logo/voda.png',
                currencies: [
                  { currency: 'CDF', operationTypes: { DEPOSIT: { status: 'OPERATIONAL' } } },
                  { currency: 'USD', operationTypes: { DEPOSIT: { status: 'OPERATIONAL' } } },
                ],
              },
              {
                provider: 'AIRTEL_COD',
                displayName: 'Airtel Money',
                currencies: [
                  { currency: 'CDF', operationTypes: { DEPOSIT: { status: 'CLOSED' } } },
                ],
              },
              // Cas mixte (bug corrigé) : USD dispo mais CDF fermé chez CET
              // opérateur → doit rester `available:true` mais n'annoncer QUE l'USD
              // (sinon PawaPay rejette une init en CDF pourtant affichée possible).
              {
                provider: 'MIXED_COD',
                displayName: 'Orange Money',
                currencies: [
                  { currency: 'USD', operationTypes: { DEPOSIT: { status: 'OPERATIONAL' } } },
                  { currency: 'CDF', operationTypes: { DEPOSIT: { status: 'CLOSED' } } },
                ],
              },
              {
                provider: 'ONLY_PAYOUT_COD',
                displayName: 'Sans dépôt',
                currencies: [{ currency: 'CDF', operationTypes: { PAYOUT: { status: 'OPERATIONAL' } } }],
              },
            ],
          },
          { country: 'BEN', providers: [{ provider: 'MTN_MOMO_BEN', currencies: [] }] },
        ],
      }),
    );

    const ops = await provider.getOperators();

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.sandbox.pawapay.io/v2/active-conf');
    expect(opts.headers.Authorization).toBe('Bearer sandbox-token');

    // Seuls les providers RDC AVEC un DEPOSIT ; ONLY_PAYOUT exclu ; BEN ignoré.
    // AIRTEL : CDF CLOSED → filtré de `currencies`, donc available:false.
    // MIXED : USD OK / CDF CLOSED → available:true mais currencies=['USD'] SEUL
    // (c'est exactement le bug corrigé : ne plus annoncer une devise CLOSED).
    expect(ops).toEqual([
      { code: 'VODACOM_MPESA_COD', name: 'Vodacom M-Pesa', available: true, logoUrl: 'https://logo/voda.png', currencies: ['CDF', 'USD'] },
      { code: 'AIRTEL_COD', name: 'Airtel Money', available: false, logoUrl: undefined, currencies: [] },
      { code: 'MIXED_COD', name: 'Orange Money', available: true, logoUrl: undefined, currencies: ['USD'] },
    ]);
    expect(prisma.paymentProviderLog.create).toHaveBeenCalled();
  });

  it('HTTP non-2xx → lève', async () => {
    fetchMock.mockResolvedValue(fakeResponse({ message: 'nope' }, false, 500));
    await expect(provider.getOperators()).rejects.toThrow();
  });

  it('cache : deux appels successifs dans le TTL ne déclenchent qu\'un seul fetch upstream', async () => {
    fetchMock.mockResolvedValue(
      fakeResponse({
        countries: [
          {
            country: 'COD',
            providers: [
              {
                provider: 'VODACOM_MPESA_COD',
                displayName: 'Vodacom M-Pesa',
                currencies: [
                  { currency: 'USD', operationTypes: { DEPOSIT: { status: 'OPERATIONAL' } } },
                ],
              },
            ],
          },
        ],
      }),
    );

    const first = await provider.getOperators();
    const second = await provider.getOperators();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('cache : un échec upstream n\'est PAS mis en cache (le prochain appel retente)', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ message: 'boom' }, false, 500));
    await expect(provider.getOperators()).rejects.toThrow();

    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        countries: [
          {
            country: 'COD',
            providers: [
              {
                provider: 'VODACOM_MPESA_COD',
                displayName: 'Vodacom M-Pesa',
                currencies: [
                  { currency: 'USD', operationTypes: { DEPOSIT: { status: 'OPERATIONAL' } } },
                ],
              },
            ],
          },
        ],
      }),
    );
    const ops = await provider.getOperators();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ops).toHaveLength(1);
  });
});
