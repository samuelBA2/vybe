import { Controller, Post, Get, Body, Param, Req, UseGuards, Headers } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { JwtAuthGuard } from "src/auth/guards/jwt-auth.guard";
import { RolesGuard } from "src/auth/guards/roles.guard";
import { Roles } from "src/auth/decorators/roles.decorator";
import { OrderService } from "./Order.service"
import { CreateOrderDto } from "./dto/CreateOrder.dto";

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
@Controller('order')
export class OrdersController {
    constructor(private readonly ordersService: OrderService){}

    // V2 : limite dédiée par IP (en plus des limites par utilisateur / numéro du service).
    @Throttle({ default: { ttl: 60_000, limit: 10 } })
    @Post()
    async create(
        @Req() req,
        @Body() dto: CreateOrderDto,
        // I1 : optionnelle (compatibilité le temps de déployer le front).
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        return this.ordersService.createOrder(req.user.sub, dto, idempotencyKey)
    }

    // Polling du front après paiement (push Mobile Money). Scope à l'utilisateur
    // courant (req.user.sub) : réponse neutre si la référence n'est pas à lui.
    @Get(':paymentRef/status')
    async status(@Req() req, @Param('paymentRef') paymentRef: string) {
        return this.ordersService.getPaymentStatus(req.user.sub, paymentRef)
    }
}