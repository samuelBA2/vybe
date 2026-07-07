import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

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
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
