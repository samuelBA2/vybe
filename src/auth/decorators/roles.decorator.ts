import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

// Déclare les rôles autorisés sur une route : @Roles('ADMIN')
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
