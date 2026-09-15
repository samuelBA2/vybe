import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { decodeCursor, parseLimit } from 'src/common/pagination';
import { EarningsService } from './earnings.service';

// Requête authentifiée : JwtAuthGuard pose request.user = payload { sub, role }.
interface AuthedRequest {
  user: { sub: string };
}

// Comptabilité organisateur (profil → page « Comptabilité », lecture seule V1).
// Scope strict à l'utilisateur connecté (req.user.sub). Retrait = Lot 2.
@UseGuards(JwtAuthGuard)
@Controller('me')
export class EarningsController {
  constructor(private readonly earnings: EarningsService) {}

  // Solde disponible + ventilation (brut / commission 15 % / net) + taux CDF.
  @Get('earnings')
  async summary(@Req() req: AuthedRequest) {
    return this.earnings.getSummary(req.user.sub);
  }

  // Recettes par événement (liste + détail par catégorie), lecture seule.
  @Get('earnings/events')
  async events(@Req() req: AuthedRequest) {
    return this.earnings.getEventsBreakdown(req.user.sub);
  }

  // Historique des ventes créditées (ledger ORGANIZER), keyset : ?limit=&cursor=.
  @Get('earnings/history')
  async history(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.earnings.getHistory(
      req.user.sub,
      parseLimit(limit),
      decodeCursor(cursor),
    );
  }
}
