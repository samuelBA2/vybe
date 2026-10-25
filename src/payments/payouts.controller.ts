import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { ClaimPayoutDto } from './dto/claim-payout.dto';
import { PayoutsService } from './payouts.service';

// Requête authentifiée : JwtAuthGuard pose request.user = { sub, role }.
interface AuthedRequest {
  user: { sub: string };
}

// Retrait organisateur (manuel/assisté). Réservé aux USER (les AGENT n'ont pas
// de recettes). Scope strict à l'utilisateur connecté (req.user.sub).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
@Controller('me/payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  // « Réclamer le net » : crée la réclamation (déduit le solde) et alerte Vybe.
  @Post('claim')
  @HttpCode(200)
  async claim(@Req() req: AuthedRequest, @Body() dto: ClaimPayoutDto) {
    return this.payouts.claimNet(
      req.user.sub,
      dto.currency,
      dto.mmoNumber,
      dto.amount,
    );
  }

  // « Renvoyer » : ré-expédie le mail de la réclamation SENT (cooldown 60 s).
  @Post('claim/:id/resend')
  @HttpCode(200)
  async resend(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.payouts.resendClaim(req.user.sub, id);
  }

  // Réclamation courante de la devise (polling / reprise de la barre).
  @Get('claim/current')
  async current(
    @Req() req: AuthedRequest,
    @Query('currency') currency: $Enums.Currency,
  ) {
    return this.payouts.getCurrentClaim(req.user.sub, currency);
  }
}
