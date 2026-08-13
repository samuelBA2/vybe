import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { PLATFORM_FEE_RATE } from "src/common/constants";
import { CreateOrderDto } from "./dto/CreateOrder.dto";


const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class OrderService {
    constructor ( private readonly prisma: PrismaService){}
    async createOrder(userId: string, dto: CreateOrderDto){ 
        // charger la catégorie + son événement 
        const category = await this.prisma.ticketCategory.findUnique({
            where: { id: dto.ticketCategoryId },
            include: { event: true}
        })
        if(!category) throw new NotFoundException('Categorie de billet introuvable.');

        // Gardes métier
        const event = category.event;
        if (event.status !== 'PUBLISHED') throw new ForbiddenException("Cet événement n'est pas ouvert à la vente.")

        if (event.purchaseDeadline < new Date()) throw new ForbiddenException("Les ventes pour cet événement sont clôturées.")

        if (dto.quantity > category.maxPerOrder) throw new ForbiddenException(`Maximum ${category.maxPerOrder} billets par commande.`)

        // Montants  (frais déduits de l'organisateur)
        const unitPrice = category.price;
        const totalAmount = round2(dto.quantity * unitPrice);
        const platformFee = round2(totalAmount * PLATFORM_FEE_RATE);
        const organizerAmount = round2(totalAmount - platformFee);

        // Transaction : réservation atomique + order + billets
        return this.prisma.$transaction(async (tx) => {
            // Reservation atomique anti-survente
            const affected = await tx.$executeRaw`
            UPDATE "TicketCategory" 
            SET "soldCount" = "soldCount" + ${dto.quantity}
            WHERE "id" = ${dto.ticketCategoryId}
            AND ("totalStock" IS NULL OR "soldCount" + ${dto.quantity} <= "totalStock")`;
            if (affected === 0) throw new ConflictException('Stock insuffisant pour cette quantité.');

        // Commande (paiement stubbé)
        const order = await tx.order.create({
            data: {
                userId,
                ticketCategoryId : dto.ticketCategoryId,
                quantity: dto.quantity,
                unitPrice, totalAmount, platformFee, organizerAmount,
                paymentStatus: 'PAID' // stub — la brique B posera le vrai PENDING→PAID
            }})
        // Billet gere le qrToken
        const tickets = Array.from({ length: dto.quantity }, () => ({
            orderId: order.id,
            ticketCategoryId: dto.ticketCategoryId,
            qrToken: randomUUID(),
            expiresAt: event.endDate,
        }))
        await tx.ticket.createMany({ data: tickets})

        return {order, tickets: tickets.map((t) => ({ qrToken: t.qrToken}))};
        })
    }
}