import { Controller, Get, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { MyTicketsService } from './MyTickets.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('USER')
@Controller('me')
export class MyTicketsController {
  constructor(private readonly myTicketsService: MyTicketsService) {}

  // GET /me/tickets billets de l'utilisateur, groupés par événement.
  @Get('tickets')
  async myTickets(@Req() req) {
    return this.myTicketsService.getMyTickets(req.user.sub);
  }

  // GET /me/tickets/:id/qr-token — token du billet (propriétaire uniquement).
  @Get('tickets/:id/qr-token')
  async qrToken(@Req() req, @Param('id') id: string) {
    return this.myTicketsService.getQrToken(req.user.sub, id);
  }
}
