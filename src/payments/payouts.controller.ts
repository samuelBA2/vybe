import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
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

  // « Réclamer le net » : signale à l'équipe Vybe le numéro Mobile Money de
  // réception. Le montant est recalculé serveur (jamais fourni par le client).
  @Post('claim')
  @HttpCode(200)
  async claim(@Req() req: AuthedRequest, @Body() dto: ClaimPayoutDto) {
    return this.payouts.claimNet(req.user.sub, dto.currency, dto.mmoNumber);
  }
}
