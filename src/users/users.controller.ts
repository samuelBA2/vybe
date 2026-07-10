import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Delete,
  UseGuards,
  Req,
  Headers,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChangePasswordDto } from './dto/change-password.dto';
import { ChangeIdentifierDto } from './dto/change-identifier.dto';
import { VerifyIdentifierDto } from './dto/verify-identifier.dto';
import { VerifyAccountDeletionDto } from './dto/verify-account-deletion.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Profil de l'utilisateur connecté — utilisé par le frontend pour
  // l'hydratation de session.
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req) {
    return this.usersService.findMe(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me')
  async update(@Req() req, @Body() dto: UpdateUserDto) {
    return this.usersService.update(req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me/password')
  async changePassword(@Req() req, @Body() dto: ChangePasswordDto) {
    return this.usersService.changePassword(req.user.sub, dto);
  }

  // Déclenche un envoi d'OTP : limite serrée contre le bombing SMS/email.
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @UseGuards(JwtAuthGuard)
  @Patch('me/identifier')
  async requestIdentifierChange(@Req() req, @Body() dto: ChangeIdentifierDto) {
    return this.usersService.requestIdentifierChange(req.user.sub, dto);
  }

  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @UseGuards(JwtAuthGuard)
  @Patch('me/identifier/verify')
  async verifyIdentifierChange(
    @Req() req,
    @Body() dto: VerifyIdentifierDto,
    @Headers('x-temp-token') tempToken: string, // tempToken dans le header
  ) {
    if (!tempToken) {
      throw new BadRequestException('Token temporaire manquant.');
    }
    return this.usersService.verifyIdentifierChange(
      req.user.sub,
      dto,
      tempToken,
    );
  }

  // Étape 1 : demande de suppression → envoi d'un code de sécurité (OTP)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @UseGuards(JwtAuthGuard)
  @Delete('me')
  async requestAccountDeletion(@Req() req) {
    return this.usersService.requestAccountDeletion(req.user.sub);
  }

  // Étape 2 : confirmation via OTP + token temporaire → soft delete
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @UseGuards(JwtAuthGuard)
  @Post('me/delete/verify')
  async verifyAccountDeletion(
    @Req() req,
    @Body() dto: VerifyAccountDeletionDto,
    @Headers('x-temp-token') tempToken: string,
  ) {
    if (!tempToken) {
      throw new BadRequestException('Token temporaire manquant.');
    }
    return this.usersService.verifyAccountDeletion(
      req.user.sub,
      dto.otp,
      tempToken,
    );
  }
}
