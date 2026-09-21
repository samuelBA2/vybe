import {
  createHash,
  generateKeyPairSync,
  KeyObject,
  sign as cryptoSign,
} from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { PawaPayProvider } from './pawapay.provider';
import { PaymentsService } from './payments.service';
import { PrismaService } from 'src/prisma/prisma.service';

// Réponse fetch factice (json + ok/status), façon Response.
function fakeResponse(body: any, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(JSON.stringify(body)),
  } as any;
}

describe('PaymentsService.handleWebhook', () => {
  let service: PaymentsService;
  let provider: PawaPayProvider;
  let privateKey: KeyObject;
  let publicPem: string;
  let fetchMock: jest.Mock;

  // Le client de transaction (tx) passé au callback de $transaction.
  let tx: {
    $executeRaw: jest.Mock;
    ticket: { createMany: jest.Mock };
    ledgerEntry: { createMany: jest.Mock };
    order: { update: jest.Mock; updateMany: jest.Mock };
  };
  let prisma: {
    paymentProviderLog: { create: jest.Mock };
    order: { findMany: jest.Mock; update: jest.Mock; updateMany: jest.Mock };
    $transaction: jest.Mock;
  };

  const PAYMENT_REF = 'dep-1111-2222';

  // Fabrique un callback signé RFC-9421 (ecdsa-p256-sha256) comme PawaPay :
  // Content-Digest (sha-512 du corps) couvert par la signature.
  function signedCallback(rawBody: string) {
    const digest =
      'sha-512=:' + createHash('sha512').update(rawBody).digest('base64') + ':';
    const params =
      '("content-digest");created=1700000000;keyid="test-key";alg="ecdsa-p256-sha256"';
    const base = `"content-digest": ${digest}\n"@signature-params": ${params}`;
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

  // Une commande PENDING par défaut (200 USD → org 170, fee 30, 2 billets).
  const order = (over: Partial<any> = {}) => ({
    id: 'order-1',
    paymentRef: PAYMENT_REF,
    ticketCategoryId: 'cat-1',
    quantity: 2,
    chargedAmount: 200,
    organizerAmount: 170,
    platformFee: 30,
    currency: 'USD',
    paymentStatus: 'PENDING',
    ticketCategory: {
      event: {
        id: 'ev-1',
        endDate: new Date('2027-01-01T00:00:00Z'),
        createdById: 'organizer-1',
      },
    },
    ...over,
  });

  // Corps de webhook + headers signés pour un paymentRef donné.
  const webhook = (ref = PAYMENT_REF) => {
    const rawBody = JSON.stringify({ depositId: ref, status: 'COMPLETED' });
    return { rawBody, headers: signedCallback(rawBody) };
  };

  // checkStatus lit GET /v2/deposits/:id (réponse enveloppée FOUND/…).
  const mockCheck = (status: string, amount?: string, currency = 'USD') =>
    fetchMock.mockResolvedValue(
      fakeResponse({
        status: 'FOUND',
        data: { depositId: PAYMENT_REF, status, amount, currency },
      }),
    );

  beforeEach(() => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    privateKey = pair.privateKey;
    publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      ticket: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      order: {
        update: jest.fn().mockResolvedValue({}),
        // Par défaut la transition conditionnelle affecte 1 ligne (l'appelant fait
        // réellement passer la commande de PENDING à son état terminal).
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    prisma = {
      paymentProviderLog: { create: jest.fn().mockResolvedValue({}) },
      order: {
        findMany: jest.fn().mockResolvedValue([order()]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };

    const config = {
      get: jest.fn((key: string) =>
        ({
          PAWAPAY_PUBLIC_KEY: publicPem,
          PAWAPAY_BASE_URL: 'https://api.sandbox.pawapay.io',
          PAWAPAY_API_TOKEN: 'sandbox-token',
        })[key],
      ),
    };
    provider = new PawaPayProvider(config as any, prisma as unknown as PrismaService);
    service = new PaymentsService(prisma as unknown as PrismaService, provider);

    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
  });

  it('signature invalide → 401, sans re-vérification (checkStatus non appelé)', async () => {
    const { rawBody } = webhook();
    await expect(service.handleWebhook(rawBody, {})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('payé → PAID + billets + 2 écritures ledger (organizer + platform) par commande', async () => {
    mockCheck('COMPLETED', '200');
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    // Re-vérification serveur bien effectuée.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2 billets (quantity=2) avec expiresAt = event.endDate.
    expect(tx.ticket.createMany).toHaveBeenCalledTimes(1);
    const tickets = tx.ticket.createMany.mock.calls[0][0].data;
    expect(tickets).toHaveLength(2);
    expect(tickets[0]).toEqual(expect.objectContaining({
      orderId: 'order-1',
      ticketCategoryId: 'cat-1',
      expiresAt: new Date('2027-01-01T00:00:00Z'),
    }));

    // 2 écritures ledger : organisateur (+170) et plateforme (+30), toutes deux
    // rattachées au userId de l'organisateur (Option A), en USD.
    expect(tx.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
    const entries = tx.ledgerEntry.createMany.mock.calls[0][0].data;
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ account: 'ORGANIZER', type: 'SALE_ORGANIZER', userId: 'organizer-1', amount: 170, currency: 'USD', orderId: 'order-1', eventId: 'ev-1' }),
      expect.objectContaining({ account: 'PLATFORM', type: 'SALE_PLATFORM', userId: 'organizer-1', amount: 30, currency: 'USD', orderId: 'order-1', eventId: 'ev-1' }),
    ]));

    // Commande passée PAID via claim conditionnel PENDING→PAID (garde de concurrence).
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', paymentStatus: 'PENDING' },
      data: { paymentStatus: 'PAID' },
    });

    expect(res).toEqual(expect.objectContaining({ paymentRef: PAYMENT_REF, status: 'PAID' }));
  });

  it('payé mais commande déjà honorée en concurrence (claim count=0) → PAS de billets ni ledger en double', async () => {
    // Un autre appelant (callback/poll/reaper) a déjà fait passer la commande à PAID :
    // notre claim PENDING→PAID n'affecte aucune ligne → aucune émission.
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    mockCheck('COMPLETED', '200');
    const { rawBody, headers } = webhook();

    await service.handleWebhook(rawBody, headers);

    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
  });

  it('CDF : ledger écrit dans la devise de la commande (pas USD hard-codé)', async () => {
    prisma.order.findMany.mockResolvedValue([order({ currency: 'CDF', chargedAmount: 450000, organizerAmount: 380000, platformFee: 70000 })]);
    mockCheck('COMPLETED', '450000', 'CDF');
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(tx.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
    const rows = tx.ledgerEntry.createMany.mock.calls[0][0].data;
    expect(rows.every((r: any) => r.currency === 'CDF')).toBe(true);
    expect(res).toEqual(expect.objectContaining({ paymentRef: PAYMENT_REF, status: 'PAID' }));
  });

  it('2ᵉ webhook (commande déjà PAID) → no-op idempotent', async () => {
    prisma.order.findMany.mockResolvedValue([order({ paymentStatus: 'PAID' })]);
    mockCheck('COMPLETED', '200');
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ paymentRef: PAYMENT_REF }));
  });

  it('EXPIRED mais stock encore dispo → re-honore (PAID + billets + ledger)', async () => {
    prisma.order.findMany.mockResolvedValue([order({ paymentStatus: 'EXPIRED' })]);
    tx.$executeRaw.mockResolvedValue(1); // re-réservation OK
    mockCheck('COMPLETED', '200');
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(tx.$executeRaw).toHaveBeenCalled(); // re-réservation de stock
    expect(tx.ticket.createMany).toHaveBeenCalledTimes(1);
    expect(tx.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', paymentStatus: 'EXPIRED' },
      data: { paymentStatus: 'PAID' },
    });
    expect(res).toEqual(expect.objectContaining({ status: 'PAID' }));
  });

  it('EXPIRED et stock reparti → REVIEW (paiement accepté non honorable)', async () => {
    prisma.order.findMany.mockResolvedValue([order({ paymentStatus: 'EXPIRED' })]);
    tx.$executeRaw.mockResolvedValue(0); // stock repris par quelqu'un d'autre
    mockCheck('COMPLETED', '200');
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', paymentStatus: 'PAID' },
      data: { paymentStatus: 'REVIEW' },
    });
    expect(res).toEqual(expect.objectContaining({ status: 'REVIEW' }));
  });

  it('refusé (DECLINED) → FAILED + stock relâché', async () => {
    mockCheck('FAILED');
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(tx.$executeRaw).toHaveBeenCalled(); // décrément du stock réservé
    // Transition conditionnelle et idempotente PENDING→FAILED (garde de concurrence).
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', paymentStatus: 'PENDING' },
      data: { paymentStatus: 'FAILED' },
    });
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ status: 'FAILED' }));
  });

  it('refusé mais commande déjà résolue en concurrence (updateMany count=0) → PAS de double relâchement de stock', async () => {
    mockCheck('FAILED');
    // Un autre appelant (callback/poll/reaper) a déjà fait la transition : notre
    // updateMany PENDING→FAILED n'affecte aucune ligne → le stock ne doit PAS être décrémenté.
    tx.order.updateMany.mockResolvedValue({ count: 0 });
    const { rawBody, headers } = webhook();

    await service.handleWebhook(rawBody, headers);

    expect(tx.$executeRaw).not.toHaveBeenCalled(); // aucun décrément de stock
  });

  it('divergence de montant (checkStatus ≠ Σ chargedAmount) → REVIEW, sans billets ni ledger', async () => {
    mockCheck('COMPLETED', '999'); // attendu 200
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(fetchMock).toHaveBeenCalledTimes(1); // checkStatus bien appelé
    expect(prisma.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ paymentStatus: 'REVIEW' }),
    }));
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ status: 'REVIEW' }));
  });

  it('paiement encore en cours (PROCESSING) → no-op', async () => {
    mockCheck('PROCESSING');
    const { rawBody, headers } = webhook();

    const res = await service.handleWebhook(rawBody, headers);

    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    expect(tx.order.update).not.toHaveBeenCalled();
    expect(res).toEqual(expect.objectContaining({ status: 'PENDING' }));
  });

  // Cœur partagé avec le reaper : même chemin que le webhook (checkStatus défensif)
  // mais, sur non-paiement, expire la commande PENDING au lieu de no-op.
  describe('resolvePayment (reaper, expireStale)', () => {
    it('non payé (PROCESSING) → EXPIRED + stock relâché', async () => {
      mockCheck('PROCESSING');
      const res = await service.resolvePayment(PAYMENT_REF, { expireStale: true });
      expect(tx.$executeRaw).toHaveBeenCalled(); // décrément du stock réservé
      // Transition conditionnelle et idempotente PENDING→EXPIRED (garde de concurrence).
      expect(tx.order.updateMany).toHaveBeenCalledWith({
        where: { id: 'order-1', paymentStatus: 'PENDING' },
        data: { paymentStatus: 'EXPIRED' },
      });
      expect(tx.ticket.createMany).not.toHaveBeenCalled();
      expect(res).toEqual(expect.objectContaining({ status: 'EXPIRED' }));
    });

    it('expiration en concurrence (updateMany count=0) → PAS de double relâchement de stock', async () => {
      mockCheck('PROCESSING');
      tx.order.updateMany.mockResolvedValue({ count: 0 }); // déjà expirée/résolue ailleurs
      await service.resolvePayment(PAYMENT_REF, { expireStale: true });
      expect(tx.$executeRaw).not.toHaveBeenCalled(); // aucun décrément de stock
    });

    it('payé tardivement (COMPLETED) → re-honore en PAID + billets + ledger', async () => {
      mockCheck('COMPLETED', '200');
      const res = await service.resolvePayment(PAYMENT_REF, { expireStale: true });
      expect(tx.ticket.createMany).toHaveBeenCalledTimes(1);
      expect(tx.ledgerEntry.createMany).toHaveBeenCalledTimes(1);
      expect(res).toEqual(expect.objectContaining({ status: 'PAID' }));
    });
  });
});
