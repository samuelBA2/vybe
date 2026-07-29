import {
  Controller,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UploadsService } from './uploads.service';
import { MAX_BYTES } from 'src/common/constants';

@Controller('uploads')
export class UploadsController {
    constructor(private readonly uploadsService: UploadsService){}

    @Post()
    @UseGuards(JwtAuthGuard)
     // memoryStorage par défaut → file.buffer dispo pour fileTypeFromBuffer.
     // limits.fileSize = 1re barrière (coupe le flux tôt, avant de tout charger en RAM).
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES} }))
    async upload(@UploadedFile() file: Express.Multer.File, @Req() req) {
        return this.uploadsService.upload(file, req.user.sub);}
    }