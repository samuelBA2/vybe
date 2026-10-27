import { IsString, IsNotEmpty } from 'class-validator';

// ID token Google (JWT signé par Google) transmis par le front.
export class GoogleLoginDto {
  @IsString()
  @IsNotEmpty({ message: 'Jeton Google requis' })
  idToken: string;
}
