import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EventsService } from './events.service';
import { EventModerationService } from './event-moderation.service';
import { CreateEventDto } from './dto/create-event.dto';
import { ModerateDto } from './dto/moderate.dto';

@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly moderationService: EventModerationService,
  ) {}

  // Création réservée aux ADMIN (tous les comptes Vybe le sont aujourd'hui).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post()
  async create(@Req() req, @Body() dto: CreateEventDto) {
    return this.eventsService.createEvent(req.user.sub, dto);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.eventsService.findOne(id);
  }

  // Lien magique du mail équipe : page de confirmation (évite la validation
  // accidentelle par préchargement du lien GET). Le bouton déclenche un POST.
  @Get('moderate')
  @Header('Content-Type', 'text/html')
  moderatePage(
    @Query('token') token: string,
    @Query('decision') decision: string,
  ): string {
    const safeDecision = decision === 'reject' ? 'reject' : 'approve';
    const label = safeDecision === 'approve' ? 'VALIDER' : 'REFUSER';
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><title>Modération Vybe</title></head>
<body style="font-family:Arial,sans-serif;background:#0d0d0d;color:#fff;text-align:center;padding:60px;">
  <h1>Confirmer : ${label}</h1>
  <p>Confirmez votre décision de modération pour cet événement.</p>
  <form method="POST" action="/events/moderate">
    <input type="hidden" name="token" value="${token ?? ''}"/>
    <input type="hidden" name="decision" value="${safeDecision}"/>
    <button type="submit" style="padding:14px 28px;border:none;border-radius:10px;font-weight:700;cursor:pointer;background:${safeDecision === 'approve' ? '#1db954' : '#e0245e'};color:#fff;">
      Confirmer : ${label}
    </button>
  </form>
</body></html>`;
  }

  @Post('moderate')
  async moderatePost(@Body() dto: ModerateDto) {
    return this.moderationService.moderate(dto.token, dto.decision);
  }
}
