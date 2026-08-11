import { IsString, IsNotEmpty } from 'class-validator';

// Connexion par mot de passe. `identifier` = email OU téléphone (détecté côté service).
// Pas de règle de complexité ici : on vérifie seulement la présence ; la complexité
// ne s'applique qu'à la création et à la réinitialisation du mot de passe.
export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: 'Identifiant requis' })
  identifier: string;

  @IsString()
  @IsNotEmpty({ message: 'Mot de passe requis' })
  password: string;
}
