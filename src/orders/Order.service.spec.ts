import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { OrderService } from './Order.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PLATFORM_FEE_RATE } from 'src/common/constants';
import { PaymentProvider } from 'src/payments/payment-provider.interface';

describe('OrderService', () => {
  let service: OrderService;
  // Le client de transaction (tx) passé au callback de $transaction.
  let tx: {
    $executeRaw: jest.Mock;
    order: { create: jest.Mock; updateMany: jest.Mock };
    ticket: { createMany: jest.Mock };
  };
  let prisma: {
    ticketCategory: { findMany: jest.Mock };
    ticket: { findMany: jest.Mock };
    order: { updateMany: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let provider: {
    initPayment: jest.Mock;
    checkStatus: jest.Mock;
    verifyWebhookSignature: jest.Mock;
    getOperators: jest.Mock;
  };

  beforeEach(() => {
    tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      order: {
        create: jest.fn().mockResolvedValue({ id: 'order-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      ticket: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma = {
      ticketCategory: { findMany: jest.fn() },
      ticket: { findMany: jest.fn().mockResolvedValue([]) },
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn(),
      },
      // $transaction exécute le callback en lui injectant notre faux tx.
      // Un throw du callback se propage (en vrai, Prisma annulerait la transaction).
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    provider = {
      initPayment: jest.fn().mockResolvedValue({ paymentRef: 'provider-ref' }),
      checkStatus: jest.fn(),
      verifyWebhookSignature: jest.fn(),
      // Opérateur disponible dans les deux devises par défaut (les tests d'invalidité
      // de devise/opérateur surchargent ce mock).
      getOperators: jest.fn().mockResolvedValue([
        { code: 'VODACOM_MPESA_COD', name: 'Vodacom M-Pesa', available: true, currencies: ['USD', 'CDF'] },
      ]),
    };
    service = new OrderService(
      prisma as unknown as PrismaService,
      provider as unknown as PaymentProvider,
    );
  });

  // Catégorie valide par défaut : PUBLISHED, deadline future, stock large,
  // événement facturé en USD (surcharger event.priceCurrency pour un cas CDF).
  const category = (over: Partial<any> = {}) => ({
    id: 'cat-1',
    name: 'Standard',
    price: 100,
    maxPerOrder: 10,
    totalStock: 50,
    soldCount: 0,
    event: {
      status: 'PUBLISHED',
      purchaseDeadline: new Date(Date.now() + 3_600_000), // +1h
      endDate: new Date(Date.now() + 7_200_000), // +2h
      priceCurrency: 'USD',
    },
    ...over,
  });

  // Panier à une seule ligne par défaut (champs push PawaPay). La devise n'est
  // plus fournie par le client : elle vient de l'événement (category.event.priceCurrency).
  const dto = (
    items: any[] = [{ ticketCategoryId: 'cat-1', quantity: 2 }],
    over: Partial<any> = {},
  ) => ({
    items,
    operator: 'VODACOM_MPESA_COD',
    phoneNumber: '243810000000',
    ...over,
  });

  it('catégorie introuvable → 404, pas de transaction', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([]); // aucune catégorie ne matche
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.initPayment).not.toHaveBeenCalled();
  });

  it('événement non PUBLISHED → 403, pas de transaction', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([
      category({ event: { status: 'PENDING_REVIEW', purchaseDeadline: new Date(Date.now() + 3_600_000), endDate: new Date() } }),
    ]);
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ventes clôturées (purchaseDeadline dépassée) → 403', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([
      category({ event: { status: 'PUBLISHED', purchaseDeadline: new Date(Date.now() - 1000), endDate: new Date() } }),
    ]);
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('quantité > maxPerOrder → 403', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category({ maxPerOrder: 5 })]);
    await expect(
      service.createOrder('user-1', dto([{ ticketCategoryId: 'cat-1', quantity: 6 }])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('catégorie en double dans le panier → 400, pas de transaction', async () => {
    await expect(
      service.createOrder('user-1', dto([
        { ticketCategoryId: 'cat-1', quantity: 1 },
        { ticketCategoryId: 'cat-1', quantity: 2 },
      ])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.ticketCategory.findMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('stock insuffisant (réservation = 0 ligne) → 409, aucune commande créée', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);
    tx.$executeRaw.mockResolvedValue(0); // la garde SQL n'a touché aucune ligne
    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(ConflictException);
    expect(tx.order.create).not.toHaveBeenCalled();
    expect(provider.initPayment).not.toHaveBeenCalled();
  });

  it("ATOMICITÉ : 2ᵉ catégorie épuisée → 409 nommant la catégorie, tout est annulé", async () => {
    const catA = category({ id: 'cat-1', name: 'Standard' });
    const catB = category({ id: 'cat-2', name: 'VIP' });
    prisma.ticketCategory.findMany.mockResolvedValue([catA, catB]);
    // 1ʳᵉ réservation OK, 2ᵉ épuisée.
    tx.$executeRaw.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(
      service.createOrder('user-1', dto([
        { ticketCategoryId: 'cat-1', quantity: 1 },
        { ticketCategoryId: 'cat-2', quantity: 1 },
      ])),
    ).rejects.toThrow('Stock insuffisant : VIP');

    // La 1ʳᵉ commande a bien été tentée dans la transaction ; le throw sur la 2ᵉ
    // provoque (en réel) le rollback de TOUT le panier — aucune 2ᵉ commande créée.
    expect(tx.order.create).toHaveBeenCalledTimes(1);
    // Jamais de billet à ce stade (paiement pas encore confirmé).
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
    // Le paiement n'est initié qu'après une réservation complète réussie.
    expect(provider.initPayment).not.toHaveBeenCalled();
  });

  it('succès (USD) : commandes PENDING + paymentRef partagé, stock réservé, init appelée, AUCUN billet', async () => {
    const catA = category({ id: 'cat-1', name: 'Standard', price: 100 });
    const catB = category({ id: 'cat-2', name: 'VIP', price: 50 });
    prisma.ticketCategory.findMany.mockResolvedValue([catA, catB]);
    tx.order.create
      .mockResolvedValueOnce({ id: 'order-1' })
      .mockResolvedValueOnce({ id: 'order-2' });

    const res = await service.createOrder('user-1', dto([
      { ticketCategoryId: 'cat-1', quantity: 2 },
      { ticketCategoryId: 'cat-2', quantity: 1 },
    ]));

    expect(PLATFORM_FEE_RATE).toBe(0.2);
    // cat-1 : 2×100 = 200 (fee 40, org 160), PENDING, chargedAmount USD = 200.
    expect(tx.order.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({
        userId: 'user-1', ticketCategoryId: 'cat-1', quantity: 2,
        totalAmount: 200, platformFee: 40, organizerAmount: 160,
        currency: 'USD', chargedAmount: 200, paymentStatus: 'PENDING',
      }),
    }));
    // cat-2 : 1×50 = 50 (fee 10, org 40), chargedAmount USD = 50.
    expect(tx.order.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        ticketCategoryId: 'cat-2', quantity: 1,
        totalAmount: 50, platformFee: 10, organizerAmount: 40,
        currency: 'USD', chargedAmount: 50, paymentStatus: 'PENDING',
      }),
    }));

    // Même paymentRef partagé par les deux commandes.
    const ref1 = tx.order.create.mock.calls[0][0].data.paymentRef;
    const ref2 = tx.order.create.mock.calls[1][0].data.paymentRef;
    expect(ref1).toBeTruthy();
    expect(ref2).toBe(ref1);

    // AUCUN billet généré tant que le paiement n'est pas confirmé.
    expect(tx.ticket.createMany).not.toHaveBeenCalled();

    // Paiement initié UNE fois, montant total = Σ chargedAmount (250 USD), push renseigné.
    expect(provider.initPayment).toHaveBeenCalledTimes(1);
    expect(provider.initPayment).toHaveBeenCalledWith(expect.objectContaining({
      paymentRef: ref1,
      amount: 250,
      currency: 'USD',
      operator: 'VODACOM_MPESA_COD',
      phoneNumber: '243810000000',
    }));

    // providerTxnId persisté sur toutes les commandes du checkout.
    expect(prisma.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentRef: ref1 },
      data: expect.objectContaining({ providerTxnId: 'provider-ref' }),
    }));

    // Retour push : pas de paymentUrl.
    expect(res).toEqual({
      paymentRef: ref1,
      currency: 'USD',
      chargedAmount: 250,
      status: 'PENDING',
    });
  });

  it("succès (CDF) : devise vient de l'event, chargedAmount = totalAmount SANS conversion, split entier", async () => {
    const catA = category({ id: 'cat-1', name: 'Standard', price: 100, event: { ...category().event, priceCurrency: 'CDF' } });
    const catB = category({ id: 'cat-2', name: 'VIP', price: 50, event: { ...category().event, priceCurrency: 'CDF' } });
    prisma.ticketCategory.findMany.mockResolvedValue([catA, catB]);
    tx.order.create
      .mockResolvedValueOnce({ id: 'order-1' })
      .mockResolvedValueOnce({ id: 'order-2' });

    const res = await service.createOrder('user-1', dto([
      { ticketCategoryId: 'cat-1', quantity: 2 },
      { ticketCategoryId: 'cat-2', quantity: 1 },
    ]));

    // Plus de conversion : chargedAmount == totalAmount, dans la devise event.
    // cat-1 : 2×100 = 200 (fee 20% entier = 40, organizer = 160).
    expect(tx.order.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ totalAmount: 200, currency: 'CDF', platformFee: 40, organizerAmount: 160, chargedAmount: 200 }),
    }));
    // cat-2 : 1×50 = 50 (fee 10, organizer 40).
    expect(tx.order.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ totalAmount: 50, currency: 'CDF', platformFee: 10, organizerAmount: 40, chargedAmount: 50 }),
    }));

    expect(provider.initPayment).toHaveBeenCalledWith(expect.objectContaining({
      amount: 250,
      currency: 'CDF',
    }));
    expect(Number.isInteger((provider.initPayment.mock.calls[0][0] as any).amount)).toBe(true);
    expect(res.chargedAmount).toBe(250);
    expect(res.currency).toBe('CDF');
  });

  it('event CDF, prix 5000 qty 1 → charged 5000, fee 1000, organizer 4000 (taux 20%)', async () => {
    const cat = category({ id: 'cat-1', name: 'Standard', price: 5000, event: { ...category().event, priceCurrency: 'CDF' } });
    prisma.ticketCategory.findMany.mockResolvedValue([cat]);

    await service.createOrder('user-1', dto([{ ticketCategoryId: 'cat-1', quantity: 1 }]));

    const orderData = tx.order.create.mock.calls[0][0].data;
    expect(orderData.currency).toBe('CDF');
    expect(orderData.chargedAmount).toBe(5000);
    expect(orderData.platformFee).toBe(1000);
    expect(orderData.organizerAmount).toBe(4000);
    expect(provider.initPayment).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'CDF' }),
    );
  });

  it('panier multi-events de devises différentes → 400, pas de transaction ni initPayment', async () => {
    const catUsd = category({ id: 'cat-1', name: 'Standard', event: { ...category().event, priceCurrency: 'USD' } });
    const catCdf = category({ id: 'cat-2', name: 'VIP', event: { ...category().event, priceCurrency: 'CDF' } });
    prisma.ticketCategory.findMany.mockResolvedValue([catUsd, catCdf]);

    await expect(
      service.createOrder('user-1', dto([
        { ticketCategoryId: 'cat-1', quantity: 1 },
        { ticketCategoryId: 'cat-2', quantity: 1 },
      ])),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.initPayment).not.toHaveBeenCalled();
  });

  it('opérateur inconnu → 400, pas de réservation de stock ni initPayment', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);

    await expect(
      service.createOrder('user-1', dto(undefined, { operator: 'INCONNU' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.initPayment).not.toHaveBeenCalled();
  });

  it("opérateur ne supportant pas la devise de l'event → 400, pas de réservation ni initPayment", async () => {
    provider.getOperators.mockResolvedValue([
      { code: 'VODACOM_MPESA_COD', name: 'Vodacom M-Pesa', available: true, currencies: ['USD'] },
    ]);
    prisma.ticketCategory.findMany.mockResolvedValue([
      category({ event: { ...category().event, priceCurrency: 'CDF' } }),
    ]);

    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provider.initPayment).not.toHaveBeenCalled();
  });

  it('opérateur non disponible (available:false) → 400', async () => {
    provider.getOperators.mockResolvedValue([
      { code: 'VODACOM_MPESA_COD', name: 'Vodacom M-Pesa', available: false, currencies: ['USD', 'CDF'] },
    ]);
    prisma.ticketCategory.findMany.mockResolvedValue([category()]);

    await expect(service.createOrder('user-1', dto())).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('échec init paiement → commandes FAILED + stock relâché + BadGatewayException', async () => {
    prisma.ticketCategory.findMany.mockResolvedValue([category({ id: 'cat-1', name: 'Standard', price: 100 })]);
    provider.initPayment.mockRejectedValue(new Error('provider down'));

    await expect(
      service.createOrder('user-1', dto([{ ticketCategoryId: 'cat-1', quantity: 2 }])),
    ).rejects.toBeInstanceOf(BadGatewayException);

    // Les commandes du checkout passent FAILED (rattrapées par paymentRef).
    const ref = tx.order.create.mock.calls[0][0].data.paymentRef;
    expect(tx.order.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { paymentRef: ref },
      data: expect.objectContaining({ paymentStatus: 'FAILED' }),
    }));
    // Stock relâché : au moins un UPDATE de décrément a été émis dans la transaction de compensation.
    // (2 réservations attendues : 1 init + 1 release ⇒ $executeRaw appelé plus d'une fois.)
    expect(tx.$executeRaw.mock.calls.length).toBeGreaterThan(1);
    // Toujours aucun billet.
    expect(tx.ticket.createMany).not.toHaveBeenCalled();
  });

  describe('getPaymentStatus', () => {
    it('aucune commande pour cet utilisateur/référence → 404 (neutre)', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      await expect(
        service.getPaymentStatus('user-1', 'ref-x'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scope strict : findMany filtre par userId ET paymentRef', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'o1', paymentStatus: 'PENDING', currency: 'USD', chargedAmount: 100 },
      ]);
      await service.getPaymentStatus('user-9', 'ref-9');
      expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { userId: 'user-9', paymentRef: 'ref-9' },
      }));
    });

    it('toutes PENDING → status PENDING, pas de ticketIds', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'o1', paymentStatus: 'PENDING', currency: 'USD', chargedAmount: 100 },
      ]);
      const res = await service.getPaymentStatus('user-1', 'ref-1');
      expect(res).toEqual(expect.objectContaining({
        paymentRef: 'ref-1', status: 'PENDING', currency: 'USD', chargedAmount: 100,
      }));
      expect((res as any).ticketIds).toBeUndefined();
      expect(prisma.ticket.findMany).not.toHaveBeenCalled();
    });

    it('toutes PAID → status PAID + ticketIds (ids seulement, jamais le qrToken)', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'o1', paymentStatus: 'PAID', currency: 'USD', chargedAmount: 100 },
        { id: 'o2', paymentStatus: 'PAID', currency: 'USD', chargedAmount: 50 },
      ]);
      prisma.ticket.findMany.mockResolvedValue([{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
      const res = await service.getPaymentStatus('user-1', 'ref-1');
      expect(res.status).toBe('PAID');
      expect(res.chargedAmount).toBe(150);
      expect((res as any).ticketIds).toEqual(['t1', 't2', 't3']);
      expect(prisma.ticket.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { orderId: { in: ['o1', 'o2'] } },
        select: { id: true },
      }));
    });

    it('refusé/expiré → status FAILED', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'o1', paymentStatus: 'FAILED', currency: 'USD', chargedAmount: 100 },
      ]);
      const res = await service.getPaymentStatus('user-1', 'ref-1');
      expect(res.status).toBe('FAILED');
    });

    it('mélange PAID + non payé → REVIEW (anomalie signalée)', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'o1', paymentStatus: 'PAID', currency: 'USD', chargedAmount: 100 },
        { id: 'o2', paymentStatus: 'EXPIRED', currency: 'USD', chargedAmount: 50 },
      ]);
      const res = await service.getPaymentStatus('user-1', 'ref-1');
      expect(res.status).toBe('REVIEW');
    });
  });
});
