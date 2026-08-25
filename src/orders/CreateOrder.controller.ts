import { Controller, Post, Body, Req, UseGuards } from "@nestjs/common";
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

    @Post()
    async create(@Req() req, @Body() dto: CreateOrderDto) {
        return this.ordersService.createOrder(req.user.sub, dto)
    }
}