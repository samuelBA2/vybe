import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { decodeCursor, parseLimit } from 'src/common/pagination';
import { PayoutsService } from './payouts.service';
import { RequestPayoutDto } from './dto/request-payout.dto';
import { VerifyPayoutDto } from './dto/verify-payout.dto';

// Requête authentifiée : JwtAuthGuard pose request.user = payload { sub, role }.
interface AuthedRequest {
  user: { sub: string };
}

// Retrait (payout) organisateur : demande OTP + confirmation + suivi. Réservé
// aux USER (les AGENT ne créent pas d'événements et n'ont pas de solde).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
@Controller('me/payouts')
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  // Étape 1 : demande de retrait → OTP + tempToken + aperçu.
  @Post()
  async request(@Req() req: AuthedRequest, @Body() dto: RequestPayoutDto) {
    return this.payouts.requestPayout(req.user.sub, dto);
  }

  // Étape 2 : confirmation OTP → débit + initiation.
  @Post('verify')
  async verify(
    @Req() req: AuthedRequest,
    @Body() dto: VerifyPayoutDto,
    @Headers('x-temp-token') tempToken: string,
  ) {
    if (!tempToken) throw new BadRequestException('Token temporaire manquant.');
    return this.payouts.verifyPayout(req.user.sub, dto.otp, tempToken);
  }

  // Historique keyset.
  @Get()
  async list(
    @Req() req: AuthedRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.payouts.listPayouts(
      req.user.sub,
      parseLimit(limit),
      decodeCursor(cursor),
    );
  }

  // Suivi (polling front).
  @Get(':payoutRef/status')
  async status(
    @Req() req: AuthedRequest,
    @Param('payoutRef') payoutRef: string,
  ) {
    return this.payouts.getPayoutStatus(req.user.sub, payoutRef);
  }
}
