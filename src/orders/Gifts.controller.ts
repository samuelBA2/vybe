import { Controller, Post, Body, Param, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { GiftService } from './Gift.service';
import { CreateGiftDto } from './dto/CreateGift.dto';

// Pas de préfixe : chemin complet events/:reference/gifts (cohérent avec les
// routes créateur du module agent). Deux segments → aucun conflit avec events/:id.
@Controller()
export class GiftsController {
  constructor(private readonly giftService: GiftService) {}

  // Émettre des billets offerts pour un événement (organisateur uniquement).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Post('events/:reference/gifts')
  async emit(@Req() req, @Param('reference') reference: string, @Body() dto: CreateGiftDto) {
    return this.giftService.emitGifts(req.user.sub, reference, dto);
  }
}
