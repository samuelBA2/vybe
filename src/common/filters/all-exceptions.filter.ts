import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// Filet de sécurité global : intercepte TOUTE exception non gérée par un filtre
// plus spécifique. Empêche qu'une erreur inattendue (bug, dépendance externe,
// erreur Prisma non typée…) ne renvoie une stack trace ou un message brut au client.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    // Les HttpException (validation, 401, 404 métier…) sont des réponses
    // volontaires : on conserve leur statut et leur message tels quels.
    if (exception instanceof HttpException) {
      return res.status(exception.getStatus()).json(exception.getResponse());
    }

    // Tout le reste = erreur non anticipée : détail journalisé côté serveur
    // uniquement, message générique renvoyé au client (jamais la stack).
    this.logger.error(
      `${req.method} ${req.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Une erreur interne est survenue.',
    });
  }
}
