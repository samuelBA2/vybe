// Fichier qui gère la revalidation type/taille et le garde-fou ESM.

import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';
import { CloudinaryFolder } from 'src/cloudinary/cloudinary.folder';
import { ALLOWED_MIME, MAX_BYTES, mimeToMediaType } from 'src/common/constants';

@Injectable()
export class UploadsService {
    private readonly logger = new Logger(UploadsService.name);

    constructor(
        private readonly cloudinary: CloudinaryService,
        private readonly prisma: PrismaService,
    ){}

    async upload(file: Express.Multer.File, ownerId: string){
        //Garde-fou : un fichier vide / buffer absent ne passe pas en silence.
        if (!file?.buffer?.length) {
            throw new BadRequestException('Aucun fichier reçu, champ "file" manquand ou vide .');
        }

        //Revalidation TAILLE côté serveur (multer est une 1re barrière, on reconfirme).
        if(file.size > MAX_BYTES){
            throw new PayloadTooLargeException(`Fichier trop volumineux (max ${MAX_BYTES / 1024 / 1024} Mo).`,);
        }
       // Revalidation TYPE par MAGIC BYTES — jamais file.mimetype (falsifiable).
       // import() DYNAMIQUE obligatoire : file-type est ESM-only, projet CommonJS/Node20.
        const { fileTypeFromBuffer } = await import('file-type');
        const detected = await fileTypeFromBuffer(file.buffer);
        if (!detected || !ALLOWED_MIME.has(detected.mime)){
            throw new UnsupportedMediaTypeException(`Type de fichier non autorisé${detected ? `(${detected.mime})` : ''}.`);

        }

        const mediaType = mimeToMediaType(detected.mime);

        //Upload Cloudinary. Si ça échoue → on remonte une erreur claire (pas de silence).
        let result;

        // PDF → resource_type 'auto' (Cloudinary route le document) ; image → 'image'.
        const resourceType = detected.mime === 'application/pdf' ? 'auto' : 'image';
        try {
            result = await this.cloudinary.uploadFile(file, CloudinaryFolder.EVENT_POSTERS, resourceType)
        } catch (err){
            this.logger.error(`Echec upload Cloudinary (owner ${ownerId})`,
                err instanceof Error ? err.stack : String(err),
            );
            throw new BadRequestException("L'upload a échoué, réessayez.");
        }

        // Enregistrer l'asset comme "orphelin potentiel" (attached=false).
        
        await this.prisma.uploadedAsset.create({
            data: {
                publicId: result.public_id,
                url: result.secure_url,
                fileName: file.originalname,
                mimeType: detected.mime,
                sizeBytes: file.size,
                mediaType,
                ownerId,
                attached: false,
            }
        });

        // Contrat de retour EXACT attendu par MediaItemDto.
        return {
            url: result.secure_url,
            fileKey: result.public_id,
            fileName: file.originalname,
            mimeType: detected.mime,
            sizeBytes: file.size,
            mediaType,
        }
    }
}