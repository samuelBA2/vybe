import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { MulterError } from 'multer';
import { Catch, ArgumentsHost, ExceptionFilter, HttpStatus } from '@nestjs/common';

// Traduit les erreurs Multer (hors cycle Nest) en réponses HTTP propres :
// LIMIT_FILE_SIZE → 413, le reste → 400. Sans ce filtre, un fichier trop
// volumineux sort en 500 opaque (échec silencieux côté client).
@Catch(MulterError)
class MulterExceptionFilter implements ExceptionFilter {
  catch(err: MulterError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const status =
      err.code === 'LIMIT_FILE_SIZE'
        ? HttpStatus.PAYLOAD_TOO_LARGE
        : HttpStatus.BAD_REQUEST;
    res
      .status(status)
      .json({ statusCode: status, message: `Upload refusé : ${err.message}` });
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // En-têtes de sécurité HTTP (HSTS, nosniff, anti-clickjacking, masque X-Powered-By…).
  // Appliqué en tout premier pour couvrir toutes les réponses, y compris les erreurs.
  // crossOriginResourcePolicy assoupli : l'API et le frontend sont sur des origines
  // différentes (le CORS ci-dessous gère déjà les origines autorisées).
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // Render/Neon sont derrière un reverse-proxy : on fait confiance au premier
  // proxy pour lire la vraie IP client (X-Forwarded-For). Indispensable pour que
  // le rate limiting (ThrottlerGuard) compte par IP réelle et non par IP du proxy.
  app.set('trust proxy', 1);

  // CORS : indispensable pour que le frontend (autre origine) puisse appeler l'API.
  // credentials: true → autorise le cookie httpOnly de refresh.
  // FRONTEND_URLS : liste d'origines autorisées séparées par des virgules.
  const origins = (
    process.env.FRONTEND_URLS ??
    'http://localhost:8080,https://vybe-frontend-gamma.vercel.app'
  )
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  // Nécessaire pour lire le cookie httpOnly du refresh token (/auth/refresh).
  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Filtres globaux : masquent les détails internes au client.
  // Ordre important : le filtre Prisma (spécifique) est enregistré AVANT le
  // catch-all (générique), sinon ce dernier interceperait aussi les erreurs Prisma.
  app.useGlobalFilters(
    new PrismaExceptionFilter(),
    new AllExceptionsFilter(),
    new MulterExceptionFilter(),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
