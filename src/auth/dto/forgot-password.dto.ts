import { IsString, IsNotEmpty } from 'class-validator';

// Demande de réinitialisation : l'utilisateur fournit son identifiant (email OU
// téléphone). L'OTP part vers ce canal. Réponse uniforme quelle que soit l'existence.
export class ForgotPasswordDto {
  @IsString()
  @IsNotEmpty({ message: 'Identifiant requis' })
  identifier: string;
}
