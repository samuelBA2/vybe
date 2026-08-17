import { Module } from "@nestjs/common";
import { OrderService } from "./Order.service";
import { OrdersController } from "./CreateOrder.controller";
import { PrismaModule } from "src/prisma/prisma.module";
import { AuthModule } from "src/auth/auth.module";
import { TicketAssetModule } from "src/ticket-asset/ticket-asset.module";

@Module({
    imports: [PrismaModule, AuthModule, TicketAssetModule],
    controllers: [OrdersController],
    providers: [OrderService]
})
export class OrderModule{}