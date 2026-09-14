import { Injectable, Inject, NotFoundException, ForbiddenException, BadRequestException, ConflictException, BadGatewayException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { PLATFORM_FEE_RATE, USD_TO_CDF_RATE } from "src/common/constants";
import { CreateOrderDto } from "./dto/CreateOrder.dto";
import { PAYMENT_PROVIDER } from "src/payments/payment-provider.interface";
import type { PaymentProvider, ProviderCurrency } from "src/payments/payment-provider.interface";


const round2 = (n: number) => Math.round(n * 100) / 100;

// Montant réellement débité pour un montant comptable en USD, dans la devise
// choisie par l'acheteur. CDF : entier (certains opérateurs Mobile Money refusent
// les décimales) ; USD : arrondi 2 décimales.
const toCharged = (usd: number, currency: ProviderCurrency) =>
    currency === 'CDF' ? Math.round(usd * USD_TO_CDF_RATE) : round2(usd);

@Injectable()
export class OrderService {

    constructor (
        private readonly prisma: PrismaService,
        @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
    ){}
    async createOrder(userId: string, dto: CreateOrderDto){
        const items = dto.items;
        const currency = dto.currency;

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

        // Montants calculés une fois : USD = base comptable, chargedAmount = part de
        // cette ligne dans le montant réellement débité (currency).
        const lines = items.map((item) => {
            const category = byId.get(item.ticketCategoryId)!;
            const unitPrice = category.price;
            const totalAmount = round2(item.quantity * unitPrice);
            const platformFee = round2(totalAmount * PLATFORM_FEE_RATE);
            const organizerAmount = round2(totalAmount - platformFee);
            const chargedAmount = toCharged(totalAmount, currency);
            return { item, category, unitPrice, totalAmount, platformFee, organizerAmount, chargedAmount };
        });

        // Référence de transaction PARTAGÉE par les N commandes d'un même checkout.
        const paymentRef = randomUUID();
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
        const orders = await this.prisma.order.findMany({
            where: { userId, paymentRef },
            select: { id: true, paymentStatus: true, currency: true, chargedAmount: true },
        });
        if (orders.length === 0) {
            throw new NotFoundException('Paiement introuvable.');
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

        const chargedAmount = orders.reduce((s, o) => s + o.chargedAmount, 0);
        const base = { paymentRef, status, currency: orders[0].currency, chargedAmount };
        if (status !== 'PAID') return base;

        const tickets = await this.prisma.ticket.findMany({
            where: { orderId: { in: orders.map((o) => o.id) } },
            select: { id: true },
        });
        return { ...base, ticketIds: tickets.map((t) => t.id) };
    }
}
