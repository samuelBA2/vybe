import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoginTicket, OAuth2Client } from 'google-auth-library';

// Profil normalisé extrait de l'ID token Google, consommé par AuthService.
export interface GoogleProfile {
  googleId: string;
  email: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  picture?: string;
}

@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly client: OAuth2Client;
  private readonly clientId: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = this.config.get<string>('GOOGLE_CLIENT_ID') ?? '';
    if (!this.clientId) {
      this.logger.warn(
        'GOOGLE_CLIENT_ID absent : la connexion Google échouera.',
      );
    }
    this.client = new OAuth2Client(this.clientId);
  }

  // Vérifie signature + audience + expiration du token côté Google, puis
  // normalise le payload. Toute erreur devient un 401 générique.
  async verifyIdToken(idToken: string): Promise<GoogleProfile> {
    let ticket: LoginTicket;
    try {
      ticket = await this.client.verifyIdToken({
        idToken,
        audience: this.clientId,
      });
    } catch {
      throw new UnauthorizedException('Connexion Google invalide.');
    }

    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email) {
      throw new UnauthorizedException('Connexion Google invalide.');
    }

    return {
      googleId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      firstName: payload.given_name,
      lastName: payload.family_name,
      picture: payload.picture,
    };
  }
}
