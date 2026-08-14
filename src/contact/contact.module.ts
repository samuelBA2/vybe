import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module';
import { ContactController } from './contact.controller';
import { ContactService } from './contact.service';

@Module({
  imports: [MailModule], // fournit MailService (envoi du mail à l'équipe)
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
