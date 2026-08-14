import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

// Motifs de contact proposés à l'utilisateur. Un enum (et non du texte libre)
// permet de router le message côté équipe et empêche toute valeur arbitraire.
export enum ContactReason {
  TICKET_ORDER = 'TICKET_ORDER', // Problème avec un billet / une commande
  EVENT_QUESTION = 'EVENT_QUESTION', // Question sur un événement
  ORGANIZER = 'ORGANIZER', // Organisateur : mon événement, modération
  ACCOUNT = 'ACCOUNT', // Compte & connexion (OTP, suppression…)
  REPORT = 'REPORT', // Signalement / abus
  OTHER = 'OTHER', // Autre
}

// Libellés lisibles (fr) associés à chaque motif, utilisés dans l'objet et le
// corps du mail envoyé à l'équipe Vybe.
export const CONTACT_REASON_LABELS: Record<ContactReason, string> = {
  [ContactReason.TICKET_ORDER]: 'Billet / commande',
  [ContactReason.EVENT_QUESTION]: 'Question sur un événement',
  [ContactReason.ORGANIZER]: 'Organisateur / mon événement',
  [ContactReason.ACCOUNT]: 'Compte & connexion',
  [ContactReason.REPORT]: 'Signalement / abus',
  [ContactReason.OTHER]: 'Autre',
};

// Validé par le ValidationPipe global (whitelist + forbidNonWhitelisted) :
// tout champ hors de ce DTO est rejeté. Les bornes MaxLength limitent aussi
// la surface d'abus (spam, injection d'en-têtes via un objet démesuré).
export class CreateContactDto {
  // Adresse de réponse : servira de `replyTo` pour que l'équipe réponde
  // directement à l'utilisateur. @IsEmail bloque déjà tout retour à la ligne
  // (défense de base contre l'injection d'en-têtes e-mail).
  @IsEmail({}, { message: 'Adresse e-mail invalide.' })
  @MaxLength(254, { message: 'Adresse e-mail trop longue.' })
  email: string;

  @IsEnum(ContactReason, { message: 'Motif invalide.' })
  reason: ContactReason;

  @IsOptional()
  @IsString()
  @MaxLength(150, { message: "L'objet ne peut dépasser 150 caractères." })
  subject?: string;

  @IsString()
  @MinLength(10, {
    message: 'Votre message doit contenir au moins 10 caractères.',
  })
  @MaxLength(2000, {
    message: 'Votre message ne peut dépasser 2000 caractères.',
  })
  message: string;
}
