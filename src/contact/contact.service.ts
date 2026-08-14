import { Injectable } from '@nestjs/common';
import { MailService } from '../mail/mail.service';
import { CreateContactDto } from './dto/create-contact.dto';

@Injectable()
export class ContactService {
  constructor(private readonly mail: MailService) {}

  // Relaie le message du formulaire de contact vers la boîte de l'équipe Vybe.
  // Aucune persistance : le mail EST le canal (comme la modération d'événement).
  // La désinfection (HTML + retours à la ligne) est faite dans MailService, au
  // plus près de la construction du message, pour couvrir tous les appelants.
  async send(dto: CreateContactDto): Promise<void> {
    await this.mail.sendContactMessage({
      fromEmail: dto.email,
      reason: dto.reason,
      subject: dto.subject,
      message: dto.message,
    });
  }
}
