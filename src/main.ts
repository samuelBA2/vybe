import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

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
  const origins = (process.env.FRONTEND_URLS ?? 'http://localhost:8080')
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
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
