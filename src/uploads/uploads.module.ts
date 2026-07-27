import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from '../auth/auth.module'; // fournit JwtAuthGuard
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { JwtModule } from '@nestjs/jwt';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';
import { UploadsCleanupService } from './uploads.cleanup';

@Module({
    imports: [
        PrismaModule,
        CloudinaryModule,
        AuthModule,
        JwtModule.register({ secret: process.env.JWT_SECRET})
    ],
    controllers: [UploadsController],
    providers: [UploadsService, UploadsCleanupService],
    })
    export class UploadsModule {}

    
