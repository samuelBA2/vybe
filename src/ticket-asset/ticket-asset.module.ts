import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { TicketAssetService } from './ticket-asset.service';
import { TicketsCleanupService } from './tickets.cleanup';

@Module({
    imports: [PrismaModule],
    providers: [TicketAssetService, TicketsCleanupService],
    exports: [TicketAssetService],
})
export class TicketAssetModule {}