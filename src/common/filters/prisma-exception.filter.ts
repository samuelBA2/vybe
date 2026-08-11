import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Response } from 'express';

// Intercepte les erreurs Prisma connues pour ne JAMAIS renvoyer au client les
// détails internes de la base (noms de tables/colonnes, contraintes, stack).
// Le message réel est loggé côté serveur ; le client reçoit un message générique.
@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    // Détail réel journalisé côté serveur uniquement (jamais exposé au client).
    this.logger.error(`Prisma ${exception.code}: ${exception.message}`);

    switch (exception.code) {
      case 'P2002': // violation de contrainte unique
        return res.status(HttpStatus.CONFLICT).json({
          statusCode: HttpStatus.CONFLICT,
          message: 'Un conflit est survenu. Veuillez réessayer.',
        });
      case 'P2025': // enregistrement introuvable
        return res.status(HttpStatus.NOT_FOUND).json({
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Ressource introuvable.',
        });
      default:
        return res.status(HttpStatus.BAD_REQUEST).json({
          statusCode: HttpStatus.BAD_REQUEST,
          message: 'Requête invalide.',
        });
    }
  }
}
