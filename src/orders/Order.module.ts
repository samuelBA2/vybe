import { Module } from "@nestjs/common";
import { OrderService } from "./Order.service";
import { OrdersController } from "./CreateOrder.controller";
import { PrismaModule } from "src/prisma/prisma.module";
import { AuthModule } from "src/auth/auth.module";
import { TicketAssetModule } from "src/ticket-asset/ticket-asset.module";
import { MyTicketsController } from "./MyTickets.controller";
import { MyTicketsService } from "./MyTickets.service";
import { GiftService } from "./Gift.service";
import { GiftsController } from "./Gifts.controller";

@Module({
    imports: [PrismaModule, AuthModule, TicketAssetModule],
    controllers: [OrdersController, MyTicketsController, GiftsController],
    providers: [OrderService, MyTicketsService, GiftService]
})
export class OrderModule{}