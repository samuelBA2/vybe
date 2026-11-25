import {
  Body,
  Controller,
  Get,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guards/roles.guard';
import { Roles } from 'src/auth/decorators/roles.decorator';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Post()
  async create(@Req() req, @Body() dto: CreateReservationDto) {
    return this.reservations.create(req.user.sub, dto);
  }

  // État "réservation active" du user pour un événement (grisage du bouton).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('USER')
  @Get('active')
  async active(
    @Req() req,
    @Query('eventId', new ParseUUIDPipe()) eventId: string,
  ) {
    return {
      hasActive: await this.reservations.hasActiveReservation(
        req.user.sub,
        eventId,
      ),
    };
  }
}
