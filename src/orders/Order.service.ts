import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException, Logger} from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "src/prisma/prisma.service";
import { PLATFORM_FEE_RATE } from "src/common/constants";
import { CreateOrderDto } from "./dto/CreateOrder.dto";
import { TicketAssetService } from "src/ticket-asset/ticket-asset.service";


const round2 = (n: number) => Math.round(n * 100) / 100;

@Injectable()
export class OrderService {

    private readonly logger = new Logger(OrderService.name);
    constructor ( private readonly prisma: PrismaService,private readonly ticketAssets: TicketAssetService){}
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

        // UNE transaction pour TOUT le panier : si une seule catégorie manque de
        // stock, le throw annule aussi les réservations déjà faites (tout ou rien).
        const orderIds = await this.prisma.$transaction(async (tx) => {
            const created: string[] = [];
            for (const item of items) {
                const category = byId.get(item.ticketCategoryId)!;

                // Réservation atomique anti-survente.
                const affected = await tx.$executeRaw`
                UPDATE "TicketCategory"
                SET "soldCount" = "soldCount" + ${item.quantity}
                WHERE "id" = ${item.ticketCategoryId}
                AND ("totalStock" IS NULL OR "soldCount" + ${item.quantity} <= "totalStock")`;
                if (affected === 0) throw new ConflictException(`Stock insuffisant : ${category.name}`);

                // Montants (frais déduits de l'organisateur).
                const unitPrice = category.price;
                const totalAmount = round2(item.quantity * unitPrice);
                const platformFee = round2(totalAmount * PLATFORM_FEE_RATE);
                const organizerAmount = round2(totalAmount - platformFee);

                const order = await tx.order.create({
                    data: {
                        userId,
                        ticketCategoryId: item.ticketCategoryId,
                        quantity: item.quantity,
                        unitPrice, totalAmount, platformFee, organizerAmount,
                        paymentStatus: 'PAID', // stub — la brique B posera le vrai PENDING→PAID
                    },
                });

                const tickets = Array.from({ length: item.quantity }, () => ({
                    orderId: order.id,
                    ticketCategoryId: item.ticketCategoryId,
                    qrToken: randomUUID(),
                    expiresAt: category.event.endDate,
                }));
                await tx.ticket.createMany({ data: tickets });
                created.push(order.id);
            }
            return created;
        });

        // Post-commit best-effort : ne doit JAMAIS faire échouer l'achat.
        for (const orderId of orderIds) {
            try {
                await this.ticketAssets.generateAssetsForOrder(orderId);
            } catch (e) {
                this.logger.error(`Géneration des visuels échouée (order ${orderId}) : ${(e instanceof Error ? e.stack : String(e))}`,);
            }
        }

        // Billets du panier avec leurs URLs (renseignées si la génération a réussi).
        const tickets = await this.prisma.ticket.findMany({
            where: { orderId: { in: orderIds } },
            select: { qrToken: true, pdfUrl: true, ticketImageUrl: true },
        });
        return { orderIds, tickets };
    }
}