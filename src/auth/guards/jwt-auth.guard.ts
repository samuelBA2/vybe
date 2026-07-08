import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    // Extraire le token du header authorization;
    const authHeader = request.headers?.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token manquant.');
    }

    const token = authHeader.split(' ')[1];

    // Vérifier et décoder le token
    try {
      const payload = this.jwtService.verify(token);
      if (payload.type !== 'access') {
        throw new UnauthorizedException('Token invalide.');
      }
      request['user'] = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Token invalide.');
    }
  }
}
