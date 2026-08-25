import { Module } from "@nestjs/common";
import { OrderService } from "./Order.service";
import { OrdersController } from "./CreateOrder.controller";
import { PrismaModule } from "src/prisma/prisma.module";
import { AuthModule } from "src/auth/auth.module";
import { TicketAssetModule } from "src/ticket-asset/ticket-asset.module";
import { MyTicketsController } from "./MyTickets.controller";
import { MyTicketsService } from "./MyTickets.service";

@Module({
    imports: [PrismaModule, AuthModule, TicketAssetModule],
    controllers: [OrdersController, MyTicketsController],
    providers: [OrderService, MyTicketsService]
})
export class OrderModule{}