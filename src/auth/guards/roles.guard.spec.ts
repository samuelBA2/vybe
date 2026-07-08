import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function makeContext(user: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  function makeGuard(requiredRoles?: string[]) {
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(requiredRoles),
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  }

  it('autorise quand aucun rôle requis', () => {
    const guard = makeGuard(undefined);
    expect(guard.canActivate(makeContext({ role: 'USER' }))).toBe(true);
  });

  it('autorise un utilisateur ayant le bon rôle', () => {
    const guard = makeGuard(['USER']);
    expect(guard.canActivate(makeContext({ role: 'USER' }))).toBe(true);
  });

  it('refuse un utilisateur sans le bon rôle', () => {
    const guard = makeGuard(['USER']);
    expect(() => guard.canActivate(makeContext({ role: 'AGENT' }))).toThrow(
      ForbiddenException,
    );
  });

  it('refuse quand il n’y a pas d’utilisateur', () => {
    const guard = makeGuard(['USER']);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
