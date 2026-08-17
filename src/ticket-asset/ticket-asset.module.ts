import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CloudinaryModule } from 'src/cloudinary/cloudinary.module';
import { TicketAssetService } from './ticket-asset.service';

@Module({
    imports: [PrismaModule, CloudinaryModule],
    providers: [TicketAssetService],
    exports: [TicketAssetService],
})
export class TicketAssetModule {}