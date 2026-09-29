import { Injectable, Inject, Logger, NotFoundException, ForbiddenException, BadRequestException, ConflictException, BadGatewayException } from "@nestjs/common";
import { newTransactionRef } from "src/common/transaction-ref";
import { PrismaService } from "src/prisma/prisma.service";
import { CreateOrderDto } from "./dto/CreateOrder.dto";
import { PAYMENT_PROVIDER } from "src/payments/payment-provider.interface";
import type { PaymentProvider } from "src/payments/payment-provider.interface";
import { PaymentsService } from "src/payments/payments.service";
import { splitAmount } from "src/common/money";


const round2 = (n: number) => Math.round(n * 100) / 100;

// Anti-martèlement : le front sonde /status toutes les ~3 s ; on ne re-vérifie
// le paiement auprès du fournisseur (checkStatus) qu'au plus une fois par
// fenêtre de ce délai et par référence, pour ne pas taper PawaPay à chaque poll.
const STATUS_RESOLVE_THROTTLE_MS = 8_000;

@Injectable()
export class OrderService {

    private readonly logger = new Logger(OrderService.name);
    // Horodatage de la dernière re-vérification par paymentRef (throttle du poll).
    // Purgé dès que la commande atteint un statut terminal → borné aux checkouts en cours.
    private readonly lastResolveAt = new Map<string, number>();

    constructor (
        private readonly prisma: PrismaService,
        @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
        private readonly payments: PaymentsService,
    ){}
    async createOrder(userId: string, dto: CreateOrderDto){
        const items = dto.items;

        // Le panier agrège déjà par catégorie : un doublon est une anomalie client.
        const ids = items.map((i) => i.ticketCategoryId);
        if (new Set(ids).size !== ids.length) {
            throw new BadRequestException('Catégorie en double dans le panier.');
        }

        // Charger toutes les catégories + leur événement en une seule requête.
        const categories = await this.prisma.ticketCategory.findMany({
            where: { id: { in: ids } },
            include: { event: true },
        });
        const byId = new Map(categories.map((c) => [c.id, c]));

        // Gardes métier de CHAQUE ligne, AVANT d'ouvrir la moindre transaction.
        for (const item of items) {
            const category = byId.get(item.ticketCategoryId);
            if (!category) throw new NotFoundException('Categorie de billet introuvable.');
            const event = category.event;
            if (event.status !== 'PUBLISHED') throw new ForbiddenException("Cet événement n'est pas ouvert à la vente.");
            if (event.purchaseDeadline < new Date()) throw new ForbiddenException("Les ventes pour cet événement sont clôturées.");
            if (item.quantity > category.maxPerOrder) throw new ForbiddenException(`Maximum ${category.maxPerOrder} billets par commande.`);
        }

        // Devise = celle de l'événement (plus de choix acheteur). Un panier ne peut
        // mélanger des catégories d'événements facturés dans des devises différentes.
        const currency = categories[0].event.priceCurrency;
        if (categories.some((c) => c.event.priceCurrency !== currency)) {
            throw new BadRequestException('Un panier ne peut mélanger des événements de devises différentes.');
        }

        // Montants calculés une fois, directement dans la devise event. Plus de
        // conversion : chargedAmount == totalAmount (ce que l'acheteur voit à
        // l'achat = ce qui est réellement débité).
        const lines = items.map((item) => {
            const category = byId.get(item.ticketCategoryId)!;
            const unitPrice = category.price;
            const totalAmount = round2(item.quantity * unitPrice);
            const { platformFee, organizerAmount } = splitAmount(totalAmount, currency);
            const chargedAmount = totalAmount;
            return { item, category, unitPrice, totalAmount, platformFee, organizerAmount, chargedAmount };
        });

        // Garde opérateur/devise : rejet 4xx clair AVANT de réserver du moindre
        // stock si l'opérateur choisi n'existe pas / n'est pas disponible / ne gère
        // pas la devise de l'événement (supprime le cas le plus fréquent d'échec
        // fournisseur, ex. AMOUNT_OUT_OF_BOUNDS par incohérence de devise).
        const operators = await this.payment.getOperators();
        const op = operators.find((o) => o.code === dto.operator);
        if (!op || !op.available || !op.currencies.includes(currency)) {
            throw new BadRequestException('Opérateur indisponible pour cette devise.');
        }

        // Référence de transaction PARTAGÉE par les N commandes d'un même checkout.
        const paymentRef = newTransactionRef();
        // Montant total réellement poussé au fournisseur = Σ chargedAmount (garde
        // l'invariant vérifié côté webhook : provider.amount == Σ chargedAmount).
        const chargedTotal = currency === 'CDF'
            ? lines.reduce((s, l) => s + l.chargedAmount, 0)
            : round2(lines.reduce((s, l) => s + l.chargedAmount, 0));

        // UNE transaction pour TOUT le panier : réservation de stock + N commandes
        // PENDING (AUCUN billet — ils ne sont générés qu'au passage PAID via webhook).
        // Si une seule catégorie manque de stock, le throw annule aussi les
        // réservations déjà faites (tout ou rien).
        await this.prisma.$transaction(async (tx) => {
            for (const line of lines) {
                const { item, category } = line;

                // Réservation atomique anti-survente.
                const affected = await tx.$executeRaw`
                UPDATE "TicketCategory"
                SET "soldCount" = "soldCount" + ${item.quantity}
                WHERE "id" = ${item.ticketCategoryId}
                AND ("totalStock" IS NULL OR "soldCount" + ${item.quantity} <= "totalStock")`;
                if (affected === 0) throw new ConflictException(`Stock insuffisant : ${category.name}`);

                await tx.order.create({
                    data: {
                        userId,
                        ticketCategoryId: item.ticketCategoryId,
                        quantity: item.quantity,
                        unitPrice: line.unitPrice,
                        totalAmount: line.totalAmount,
                        platformFee: line.platformFee,
                        organizerAmount: line.organizerAmount,
                        currency,
                        chargedAmount: line.chargedAmount,
                        paymentRef,
                        paymentStatus: 'PENDING',
                    },
                });
            }
        });

        // Initiation du paiement HORS transaction (appel réseau : ne jamais retenir
        // une transaction Prisma ouverte pendant un appel externe).
        let initResult: { paymentRef: string; paymentUrl?: string };
        try {
            initResult = await this.payment.initPayment({
                paymentRef,
                amount: chargedTotal,
                currency,
                operator: dto.operator,
                phoneNumber: dto.phoneNumber,
                redirectUrl: `${process.env.API_BASE_URL ?? ''}/payments/webhook`,
                description: 'Vybe billets',
            });
        } catch {
            // Échec de l'initiation : compensation — commandes FAILED + stock relâché
            // (tout ou rien). Le reaper n'a alors rien à rattraper.
            await this.prisma.$transaction(async (tx) => {
                for (const line of lines) {
                    await tx.$executeRaw`
                    UPDATE "TicketCategory"
                    SET "soldCount" = "soldCount" - ${line.item.quantity}
                    WHERE "id" = ${line.item.ticketCategoryId}`;
                }
                await tx.order.updateMany({
                    where: { paymentRef },
                    data: { paymentStatus: 'FAILED' },
                });
            });
            throw new BadGatewayException("Le paiement n'a pas pu être initié. Réessayez.");
        }

        // Trace fournisseur sur toutes les commandes du checkout (réconciliation).
        await this.prisma.order.updateMany({
            where: { paymentRef },
            data: { providerTxnId: initResult.paymentRef },
        });

        // Modèle PUSH : pas de paymentUrl. Le client saisit opérateur + numéro, reçoit
        // le prompt USSD/PIN, puis suit l'avancement via GET /order/:paymentRef/status.
        return {
            paymentRef,
            currency,
            chargedAmount: chargedTotal,
            status: 'PENDING' as const,
        };
    }

    // Statut agrégé d'un checkout (les N commandes d'un paymentRef), pour le polling
    // du front après paiement. Scope STRICT à l'utilisateur : on ne révèle jamais
    // une référence qui n'est pas à lui (réponse neutre = 404). ticketIds fournis
    // seulement si PAID (ids seuls — le qrToken ne sort que par l'endpoint gardé).
    async getPaymentStatus(userId: string, paymentRef: string) {
        let orders = await this.loadCheckoutOrders(userId, paymentRef);
        if (orders.length === 0) {
            throw new NotFoundException('Paiement introuvable.');
        }

        // Auto-vérification : tant qu'une commande est PENDING, on re-vérifie
        // activement auprès du fournisseur (checkStatus via resolvePayment = source
        // de vérité) au lieu d'attendre le seul callback (qui peut ne jamais
        // arriver : test local injoignable, callback perdu…) ou le reaper (jusqu'à
        // 25 min). resolvePayment est idempotent : PENDING → no-op, DECLINED →
        // FAILED, COMPLETED → PAID + billets. Throttlé par référence pour ne pas
        // marteler le fournisseur à chaque poll ; on ne casse JAMAIS la lecture de
        // statut si le fournisseur est injoignable (le reaper reste le filet).
        if (orders.some((o) => o.paymentStatus === 'PENDING') && this.shouldResolve(paymentRef)) {
            try {
                await this.payments.resolvePayment(paymentRef);
                orders = await this.loadCheckoutOrders(userId, paymentRef);
            } catch (err) {
                this.logger.warn(
                    `Auto-vérification du paiement ${paymentRef} échouée (état courant renvoyé) : ${String(err)}`,
                );
            }
        }

        const statuses = orders.map((o) => o.paymentStatus);
        let status: 'PENDING' | 'PAID' | 'FAILED' | 'REVIEW';
        if (statuses.some((s) => s === 'PENDING')) status = 'PENDING';
        else if (statuses.some((s) => s === 'REVIEW')) status = 'REVIEW';
        else if (statuses.every((s) => s === 'PAID')) status = 'PAID';
        // Terminal mixte (une partie PAID, une partie FAILED/EXPIRED) = anomalie
        // (un checkout est payé d'un bloc) → résolution manuelle.
        else if (statuses.some((s) => s === 'PAID')) status = 'REVIEW';
        else status = 'FAILED'; // toutes FAILED/EXPIRED

        // Statut terminal atteint : plus rien à re-vérifier → on purge l'entrée de
        // throttle pour borner la Map aux seuls checkouts encore en cours.
        if (status !== 'PENDING') this.lastResolveAt.delete(paymentRef);

        const chargedAmount = orders.reduce((s, o) => s + o.chargedAmount, 0);
        const base = { paymentRef, status, currency: orders[0].currency, chargedAmount };
        if (status !== 'PAID') return base;

        const tickets = await this.prisma.ticket.findMany({
            where: { orderId: { in: orders.map((o) => o.id) } },
            select: { id: true },
        });
        return { ...base, ticketIds: tickets.map((t) => t.id) };
    }

    // Charge les commandes d'un checkout (scope strict userId+paymentRef). Isolé
    // car appelé jusqu'à deux fois par getPaymentStatus (avant/après re-vérification).
    private loadCheckoutOrders(userId: string, paymentRef: string) {
        return this.prisma.order.findMany({
            where: { userId, paymentRef },
            select: { id: true, paymentStatus: true, currency: true, chargedAmount: true },
        });
    }

    // Throttle de l'auto-vérification : true au plus une fois par fenêtre
    // STATUS_RESOLVE_THROTTLE_MS et par référence. Marque l'instant courant quand
    // il autorise, pour que les polls rapprochés suivants soient ignorés.
    private shouldResolve(paymentRef: string): boolean {
        const now = Date.now();
        const last = this.lastResolveAt.get(paymentRef) ?? 0;
        if (now - last < STATUS_RESOLVE_THROTTLE_MS) return false;
        this.lastResolveAt.set(paymentRef, now);
        return true;
    }
}
