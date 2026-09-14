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
    return this.payments.handleWebhook(raw.toString('utf8'), headers);
  }
}
