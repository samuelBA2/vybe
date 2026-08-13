import { Module } from "@nestjs/common";
import { OrderService } from "./Order.service";
import { OrdersController } from "./CreateOrder.controller";
import { PrismaModule } from "src/prisma/prisma.module";
import { AuthModule } from "src/auth/auth.module";

@Module({
    imports: [PrismaModule, AuthModule],
    controllers: [OrdersController],
    providers: [OrderService]
})
 export class OrderModule{}