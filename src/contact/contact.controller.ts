import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';

@Controller('contact')
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  // Formulaire « Contacter l'équipe Vybe ». Route publique volontairement :
  // un utilisateur bloqué (OTP non reçu, connexion impossible) doit pouvoir
  // écrire. Rate limit resserré (3 messages / 10 min / IP) par-dessus le
  // throttler global — évite d'en faire un relais de spam.
  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { ttl: 600_000, limit: 3 } })
  async send(@Body() dto: CreateContactDto): Promise<void> {
    await this.contactService.send(dto);
  }
}
