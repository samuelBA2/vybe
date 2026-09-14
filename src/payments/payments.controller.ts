import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { PaymentsService } from './payments.service';
import type { WebhookRequestContext } from './payment-provider.interface';

// Endpoint PUBLIC (aucun JwtAuthGuard) : c'est le fournisseur (PawaPay) qui appelle.
// L'authenticité repose sur la signature du corps, vérifiée dans le service
// (fail-closed 401). On lit le corps BRUT (rawBody) : la signature RFC-9421 porte
// sur les octets exacts reçus, pas sur le JSON re-sérialisé.
@Controller('payments')
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string>,
  ) {
    const raw = req.rawBody;
    if (!raw) {
      throw new BadRequestException('Corps de webhook absent.');
    }

    // Contexte requête pour les composants dérivés RFC-9421 signés par PawaPay en
    // prod (@method/@path/@authority). `trust proxy` étant actif, on privilégie
    // l'hôte transmis par le reverse-proxy (Render), qui correspond à l'autorité de
    // l'URL de callback publique appelée par PawaPay.
    const qIndex = req.originalUrl.indexOf('?');
    const context: WebhookRequestContext = {
      method: req.method,
      path: req.path,
      authority:
        (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? '',
      query: qIndex >= 0 ? req.originalUrl.slice(qIndex + 1) : undefined,
    };

    return this.payments.handleWebhook(raw.toString('utf8'), headers, context);
  }
}
