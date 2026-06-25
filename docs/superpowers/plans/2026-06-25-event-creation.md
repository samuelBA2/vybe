# Création d'événement + modération — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permettre à un admin de créer un événement complet (données + médias + 1–4 catégories de billets) qui part en modération par mail (validation/refus via liens magiques) avant publication.

**Architecture:** Module unique `events` (Approche 1) avec services focalisés : `EventsService` (création + validation + transaction) et `EventModerationService` (tokens + décision). `RolesGuard` réutilisable. `MailService` étendu pour les mails de modération/décision. Le client fournit des URLs déjà hébergées (pas d'upload backend).

**Tech Stack:** NestJS, TypeScript, Prisma (PostgreSQL), `@nestjs/jwt`, class-validator/class-transformer, Jest, SendGrid (`@sendgrid/mail`).

## Global Constraints

- Commentaires et messages d'erreur **en français** (cohérence codebase).
- Enums Prisma importés via `import { $Enums } from '@prisma/client'` (ex. `$Enums.Role.ADMIN`, `$Enums.EventStatus.PENDING_REVIEW`).
- `PrismaService` importé depuis `src/prisma/prisma.service`.
- Token JWT de session = `{ sub, role }` ; le payload entier est attaché à `request.user` par `JwtAuthGuard` → utiliser `req.user.sub` (userId) et `req.user.role`.
- Anti-rejeu via table `UsedToken` (`prisma.usedToken.findUnique({ where: { jti } })` / `create({ data: { jti } })`).
- `ValidationPipe` global déjà actif (`whitelist`, `forbidNonWhitelisted`, `transform`) → DTO nested nécessitent `@ValidateNested` + `@Type`.
- Tests : `npx jest src/<chemin>.spec.ts` (rootDir `src`, matche `*.spec.ts`).
- Commits fréquents, un par tâche.

---

### Task 1: Migration du schéma Prisma

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Produces: enum `EventStatus` avec `PENDING_REVIEW`, `REJECTED` ; `Event.reviewedAt: DateTime?` ; `EventMedia.isPoster: Boolean` ; `TicketCategory.totalStock: Int?` (nullable) + `TicketCategory.ticketDesignUrl: String`.

- [ ] **Step 1: Modifier l'enum `EventStatus`**

Dans `prisma/schema.prisma`, remplacer le bloc enum existant :

```prisma
enum EventStatus {
  DRAFT
  PENDING_REVIEW
  PUBLISHED
  REJECTED
  CLOSED
  CANCELLED
}
```

- [ ] **Step 2: Ajouter `reviewedAt` sur `Event`**

Dans `model Event`, après la ligne `createdAt     DateTime     @default(now())`, ajouter :

```prisma
  reviewedAt    DateTime?   // date de la décision de modération (validation/refus)
```

- [ ] **Step 3: Ajouter `isPoster` sur `EventMedia`**

Dans `model EventMedia`, après `mediaType MediaType`, ajouter :

```prisma
  isPoster  Boolean   @default(false) // true pour l'affiche (exactement 1 par événement)
```

- [ ] **Step 4: Rendre `totalStock` nullable et ajouter `ticketDesignUrl` sur `TicketCategory`**

Dans `model TicketCategory`, remplacer `totalStock   Int     // Capacité max` par :

```prisma
  totalStock   Int?    // null = stock illimité
  ticketDesignUrl String // URL de l'image de design du billet
```

- [ ] **Step 5: Créer et appliquer la migration**

Run: `npx prisma migrate dev --name event_creation_moderation`
Expected: migration créée et appliquée sans erreur, message `Your database is now in sync with your schema.`

- [ ] **Step 6: Régénérer le client Prisma**

Run: `npx prisma generate`
Expected: `Generated Prisma Client` sans erreur.

- [ ] **Step 7: Vérifier la compilation**

Run: `npm run build`
Expected: build OK (les changements de schéma n'ont pas cassé le code existant).

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "feat(events): migration schéma pour création et modération d'événement"
```

---

### Task 2: RolesGuard + décorateur @Roles

**Files:**
- Create: `src/auth/decorators/roles.decorator.ts`
- Create: `src/auth/guards/roles.guard.ts`
- Test: `src/auth/guards/roles.guard.spec.ts`

**Interfaces:**
- Consumes: `request.user.role` (posé par `JwtAuthGuard`).
- Produces: `@Roles(...roles: string[])` (décorateur, clé metadata `'roles'`) ; `RolesGuard implements CanActivate`.

- [ ] **Step 1: Écrire le test qui échoue**

Créer `src/auth/guards/roles.guard.spec.ts` :

```typescript
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

function makeContext(user: any, requiredRoles?: string[]): ExecutionContext {
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
    expect(guard.canActivate(makeContext({ role: 'ADMIN' }))).toBe(true);
  });

  it('autorise un utilisateur ayant le bon rôle', () => {
    const guard = makeGuard(['ADMIN']);
    expect(guard.canActivate(makeContext({ role: 'ADMIN' }))).toBe(true);
  });

  it('refuse un utilisateur sans le bon rôle', () => {
    const guard = makeGuard(['ADMIN']);
    expect(() => guard.canActivate(makeContext({ role: 'AGENT' }))).toThrow(
      ForbiddenException,
    );
  });

  it('refuse quand il n’y a pas d’utilisateur', () => {
    const guard = makeGuard(['ADMIN']);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/auth/guards/roles.guard.spec.ts`
Expected: FAIL (`Cannot find module './roles.guard'`).

- [ ] **Step 3: Créer le décorateur**

Créer `src/auth/decorators/roles.decorator.ts` :

```typescript
import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';

// Déclare les rôles autorisés sur une route : @Roles('ADMIN')
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
```

- [ ] **Step 4: Créer le guard**

Créer `src/auth/guards/roles.guard.ts` :

```typescript
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Aucune contrainte de rôle sur la route : on laisse passer.
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user || !requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        "Vous n'avez pas les droits nécessaires pour cette action.",
      );
    }
    return true;
  }
}
```

- [ ] **Step 5: Lancer le test pour vérifier le succès**

Run: `npx jest src/auth/guards/roles.guard.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/auth/decorators/roles.decorator.ts src/auth/guards/roles.guard.ts src/auth/guards/roles.guard.spec.ts
git commit -m "feat(auth): ajout du RolesGuard et du décorateur @Roles"
```

---

### Task 3: DTOs de création et de modération

**Files:**
- Create: `src/events/dto/media-item.dto.ts`
- Create: `src/events/dto/ticket-category.dto.ts`
- Create: `src/events/dto/create-event.dto.ts`
- Create: `src/events/dto/moderate.dto.ts`

**Interfaces:**
- Produces: `MediaItemDto`, `TicketCategoryDto`, `CreateEventDto`, `ModerateDto` — utilisés par `EventsController`/`EventsService`.

- [ ] **Step 1: Créer `MediaItemDto`**

Créer `src/events/dto/media-item.dto.ts` :

```typescript
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Min,
} from 'class-validator';
import { $Enums } from '@prisma/client';

export class MediaItemDto {
  @IsString()
  @IsNotEmpty()
  url: string;

  @IsString()
  @IsNotEmpty()
  fileKey: string;

  @IsString()
  @IsNotEmpty()
  fileName: string;

  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @IsInt()
  @Min(0)
  sizeBytes: number;

  @IsEnum($Enums.MediaType)
  mediaType: $Enums.MediaType;

  @IsBoolean()
  isPoster: boolean;
}
```

- [ ] **Step 2: Créer `TicketCategoryDto`**

Créer `src/events/dto/ticket-category.dto.ts` :

```typescript
import {
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class TicketCategoryDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsString()
  @IsNotEmpty()
  ticketDesignUrl: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxPerOrder?: number;

  @IsOptional()
  @IsString()
  benefits?: string;
}
```

- [ ] **Step 3: Créer `CreateEventDto`**

Créer `src/events/dto/create-event.dto.ts` :

```typescript
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsEnum,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { $Enums } from '@prisma/client';
import { MediaItemDto } from './media-item.dto';
import { TicketCategoryDto } from './ticket-category.dto';

export class CreateEventDto {
  @IsString()
  @IsNotEmpty()
  title: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsISO8601()
  startDate: string;

  @IsISO8601()
  endDate: string;

  @IsString()
  @IsNotEmpty()
  location: string;

  @IsISO8601()
  purchaseDeadline: string;

  @IsEnum($Enums.EventCategory)
  category: $Enums.EventCategory;

  @IsOptional()
  @IsNumber()
  gpsLat?: number;

  @IsOptional()
  @IsNumber()
  gpsLng?: number;

  @IsOptional()
  @IsString()
  dressCode?: string;

  // Doit valoir explicitement true (l'utilisateur accepte les conditions).
  @Equals(true)
  termsAccepted: boolean;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  media: MediaItemDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => TicketCategoryDto)
  ticketCategories: TicketCategoryDto[];
}
```

- [ ] **Step 4: Créer `ModerateDto`**

Créer `src/events/dto/moderate.dto.ts` :

```typescript
import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export class ModerateDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsIn(['approve', 'reject'])
  decision: 'approve' | 'reject';
}
```

- [ ] **Step 5: Vérifier la compilation**

Run: `npm run build`
Expected: build OK.

- [ ] **Step 6: Commit**

```bash
git add src/events/dto
git commit -m "feat(events): DTOs de création d'événement et de modération"
```

---

### Task 4: Mails de modération et de décision

**Files:**
- Modify: `src/mail/mail.service.ts`
- Test: `src/mail/mail.service.spec.ts` (ajouts)

**Interfaces:**
- Consumes: `@sendgrid/mail` (déjà importé comme `sgMail`).
- Produces:
  - `sendEventModerationEmail(params: ModerationEmailParams): Promise<void>`
  - `sendEventDecisionEmail(to: string, eventTitle: string, approved: boolean): Promise<void>`
  - type exporté `ModerationEmailParams` (voir Step 1).

- [ ] **Step 1: Écrire les tests qui échouent**

Créer/compléter `src/mail/mail.service.spec.ts`. Si le fichier existe déjà (généré), ajouter ce `describe` ; sinon créer le fichier avec ce contenu :

```typescript
import { MailService } from './mail.service';
import sgMail from '@sendgrid/mail';

jest.mock('@sendgrid/mail', () => ({
  __esModule: true,
  default: { setApiKey: jest.fn(), send: jest.fn().mockResolvedValue(undefined) },
}));

describe('MailService — événements', () => {
  let service: MailService;
  const send = (sgMail as any).send as jest.Mock;

  beforeEach(() => {
    send.mockClear();
    service = new MailService();
  });

  it('sendEventModerationEmail envoie un mail contenant le titre, l’affiche et les liens', async () => {
    await service.sendEventModerationEmail({
      to: 'team@vybe.app',
      title: 'Soirée Test',
      description: 'desc',
      startDate: new Date('2030-01-01T20:00:00Z'),
      endDate: new Date('2030-01-01T23:00:00Z'),
      location: 'Kinshasa',
      gpsLat: null,
      gpsLng: null,
      category: 'CONCERT',
      dressCode: null,
      purchaseDeadline: new Date('2030-01-01T18:00:00Z'),
      creatorLabel: 'user-123',
      posterUrl: 'https://cdn/affiche.png',
      ticketCategories: [
        { name: 'VIP', price: 100, ticketDesignUrl: 'https://cdn/vip.png' },
      ],
      approveUrl: 'https://api/events/moderate?token=t&decision=approve',
      rejectUrl: 'https://api/events/moderate?token=t&decision=reject',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe('team@vybe.app');
    expect(msg.html).toContain('Soirée Test');
    expect(msg.html).toContain('https://cdn/affiche.png');
    expect(msg.html).toContain('decision=approve');
    expect(msg.html).toContain('decision=reject');
    expect(msg.html).toContain('VIP');
  });

  it('sendEventDecisionEmail (validé) mentionne la validation', async () => {
    await service.sendEventDecisionEmail('u@x.com', 'Soirée Test', true);
    const msg = send.mock.calls[0][0];
    expect(msg.to).toBe('u@x.com');
    expect(msg.html).toContain('Soirée Test');
    expect(msg.subject.toLowerCase()).toContain('validé');
  });

  it('sendEventDecisionEmail (refusé) mentionne le refus', async () => {
    await service.sendEventDecisionEmail('u@x.com', 'Soirée Test', false);
    const msg = send.mock.calls[0][0];
    expect(msg.subject.toLowerCase()).toContain('refus');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/mail/mail.service.spec.ts`
Expected: FAIL (`sendEventModerationEmail is not a function`).

- [ ] **Step 3: Ajouter le type et les méthodes**

Dans `src/mail/mail.service.ts`, ajouter avant la classe le type :

```typescript
export interface ModerationEmailParams {
  to: string;
  title: string;
  description: string;
  startDate: Date;
  endDate: Date;
  location: string;
  gpsLat: number | null;
  gpsLng: number | null;
  category: string;
  dressCode: string | null;
  purchaseDeadline: Date;
  creatorLabel: string;
  posterUrl: string;
  ticketCategories: { name: string; price: number; ticketDesignUrl: string }[];
  approveUrl: string;
  rejectUrl: string;
}
```

Puis ajouter ces deux méthodes dans la classe `MailService` (avant `findAll()`). Le HTML réutilise le style sombre/dégradé existant :

```typescript
  async sendEventModerationEmail(params: ModerationEmailParams): Promise<void> {
    const fmt = (d: Date) => d.toLocaleString('fr-FR');
    const gps =
      params.gpsLat != null && params.gpsLng != null
        ? `${params.gpsLat}, ${params.gpsLng}`
        : '—';

    const ticketsRows = params.ticketCategories
      .map(
        (t) => `
        <tr>
          <td style="padding:8px 12px;color:#ddd;border-bottom:1px solid #222;">${t.name}</td>
          <td style="padding:8px 12px;color:#ddd;border-bottom:1px solid #222;">${t.price} USD</td>
          <td style="padding:8px 12px;border-bottom:1px solid #222;">
            <img src="${t.ticketDesignUrl}" alt="design ${t.name}" width="80" style="border-radius:6px;"/>
          </td>
        </tr>`,
      )
      .join('');

    const row = (label: string, value: string) => `
      <tr>
        <td style="padding:8px 12px;color:#888;font-size:13px;width:160px;">${label}</td>
        <td style="padding:8px 12px;color:#eee;font-size:14px;">${value}</td>
      </tr>`;

    const msg = {
      to: params.to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL!,
        name: process.env.SENDGRID_FROM_NAME || 'Vybe Team',
      },
      subject: `Nouvel événement à valider : ${params.title}`,
      text:
        `Nouvel événement à valider : ${params.title}\n` +
        `Lieu : ${params.location}\nDébut : ${fmt(params.startDate)}\n` +
        `Valider : ${params.approveUrl}\nRefuser : ${params.rejectUrl}`,
      html: `
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#141414;border-radius:16px;overflow:hidden;">
        <tr><td align="center" style="background:linear-gradient(135deg,#7B2FF7,#F107A3);padding:32px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Événement à modérer</h1>
        </td></tr>
        <tr><td style="padding:24px 32px;">
          <img src="${params.posterUrl}" alt="affiche" width="536" style="width:100%;border-radius:12px;margin-bottom:24px;"/>
          <h2 style="color:#fff;margin:0 0 16px;">${params.title}</h2>
          <p style="color:#aaa;line-height:1.6;">${params.description}</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:#1a1a1a;border-radius:10px;">
            ${row('Début', fmt(params.startDate))}
            ${row('Fin', fmt(params.endDate))}
            ${row('Lieu', params.location)}
            ${row('GPS', gps)}
            ${row('Catégorie', params.category)}
            ${row('Dress code', params.dressCode || '—')}
            ${row('Limite achat', fmt(params.purchaseDeadline))}
            ${row('Créateur', params.creatorLabel)}
          </table>
          <h3 style="color:#fff;margin:24px 0 8px;">Catégories de billets</h3>
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:10px;">
            <tr>
              <th style="text-align:left;padding:8px 12px;color:#888;font-size:12px;">Nom</th>
              <th style="text-align:left;padding:8px 12px;color:#888;font-size:12px;">Prix</th>
              <th style="text-align:left;padding:8px 12px;color:#888;font-size:12px;">Design</th>
            </tr>
            ${ticketsRows}
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:32px;"><tr>
            <td align="center" style="padding:8px;">
              <a href="${params.approveUrl}" style="display:inline-block;background:#1db954;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;">✅ Valider</a>
            </td>
            <td align="center" style="padding:8px;">
              <a href="${params.rejectUrl}" style="display:inline-block;background:#e0245e;color:#fff;text-decoration:none;padding:14px 28px;border-radius:10px;font-weight:700;">❌ Refuser</a>
            </td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
    };

    try {
      await sgMail.send(msg);
      this.logger.log(`Mail de modération envoyé à ${params.to}`);
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du mail de modération : ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le mail de modération.",
      );
    }
  }

  async sendEventDecisionEmail(
    to: string,
    eventTitle: string,
    approved: boolean,
  ): Promise<void> {
    const subject = approved
      ? `Votre événement a été validé : ${eventTitle}`
      : `Votre événement a été refusé : ${eventTitle}`;
    const body = approved
      ? `Bonne nouvelle ! Votre événement « ${eventTitle} » a été validé par l'équipe Vybe et est désormais publié.`
      : `Votre événement « ${eventTitle} » n'a pas été retenu par l'équipe Vybe. Vous pouvez nous contacter pour plus d'informations.`;

    const msg = {
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL!,
        name: process.env.SENDGRID_FROM_NAME || 'Vybe Team',
      },
      subject,
      text: body,
      html: `
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#0d0d0d;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d0d0d;padding:40px 0;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#141414;border-radius:16px;overflow:hidden;">
        <tr><td align="center" style="background:linear-gradient(135deg,#7B2FF7,#F107A3);padding:32px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">${approved ? 'Événement validé' : 'Événement refusé'}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px;">
          <p style="color:#ccc;font-size:15px;line-height:1.7;">${body}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`,
    };

    try {
      await sgMail.send(msg);
      this.logger.log(`Mail de décision (${approved ? 'validé' : 'refusé'}) envoyé à ${to}`);
    } catch (error) {
      this.logger.error(
        `Erreur lors de l'envoi du mail de décision : ${error.message}`,
      );
      throw new InternalServerErrorException(
        "Impossible d'envoyer le mail de décision.",
      );
    }
  }
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest src/mail/mail.service.spec.ts`
Expected: PASS (les 3 nouveaux tests passent).

- [ ] **Step 5: Commit**

```bash
git add src/mail/mail.service.ts src/mail/mail.service.spec.ts
git commit -m "feat(mail): mails de modération d'événement et de décision"
```

---

### Task 5: EventModerationService

**Files:**
- Create: `src/events/event-moderation.service.ts`
- Test: `src/events/event-moderation.service.spec.ts`

**Interfaces:**
- Consumes: `JwtService` (`@nestjs/jwt`), `PrismaService`, `MailService`, `randomUUID` (`crypto`).
- Produces:
  - `generateModerationToken(eventId: string): string`
  - `moderate(token: string, decision: 'approve' | 'reject'): Promise<{ message: string }>`

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `src/events/event-moderation.service.spec.ts` :

```typescript
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventModerationService } from './event-moderation.service';

describe('EventModerationService', () => {
  let service: EventModerationService;
  let jwt: any;
  let prisma: any;
  let mail: any;

  beforeEach(() => {
    jwt = {
      sign: jest.fn().mockReturnValue('signed.jwt'),
      verify: jest.fn(),
    };
    prisma = {
      usedToken: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() },
      event: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn(async (cb) => cb(prisma)),
    };
    mail = { sendEventDecisionEmail: jest.fn().mockResolvedValue(undefined) };
    service = new EventModerationService(jwt, prisma, mail);
  });

  it('generateModerationToken signe un token typé', () => {
    const token = service.generateModerationToken('evt-1');
    expect(token).toBe('signed.jwt');
    const payload = jwt.sign.mock.calls[0][0];
    expect(payload.sub).toBe('evt-1');
    expect(payload.type).toBe('event-moderation');
    expect(payload.jti).toBeDefined();
  });

  it('refuse un token invalide', async () => {
    jwt.verify.mockImplementation(() => {
      throw new Error('bad');
    });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuse un token du mauvais type', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'login-verify', jti: 'j1' });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuse un jti déjà utilisé', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'event-moderation', jti: 'j1' });
    prisma.usedToken.findUnique.mockResolvedValue({ jti: 'j1' });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      ConflictException,
    );
  });

  it('refuse si l’événement est introuvable', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'event-moderation', jti: 'j1' });
    prisma.event.findUnique.mockResolvedValue(null);
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuse si l’événement n’est plus en attente', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'event-moderation', jti: 'j1' });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PUBLISHED',
    });
    await expect(service.moderate('x', 'approve')).rejects.toThrow(
      ConflictException,
    );
  });

  it('approuve : passe à PUBLISHED, consomme le jti, notifie le créateur', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'event-moderation', jti: 'j1' });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PENDING_REVIEW',
      title: 'Soirée',
      createdBy: { email: 'u@x.com' },
    });
    const res = await service.moderate('x', 'approve');
    expect(prisma.event.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt-1' },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );
    expect(prisma.usedToken.create).toHaveBeenCalledWith({ data: { jti: 'j1' } });
    expect(mail.sendEventDecisionEmail).toHaveBeenCalledWith('u@x.com', 'Soirée', true);
    expect(res.message).toContain('validé');
  });

  it('refuse (reject) : passe à REJECTED et notifie', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'event-moderation', jti: 'j1' });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PENDING_REVIEW',
      title: 'Soirée',
      createdBy: { email: 'u@x.com' },
    });
    await service.moderate('x', 'reject');
    expect(prisma.event.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED' }),
      }),
    );
    expect(mail.sendEventDecisionEmail).toHaveBeenCalledWith('u@x.com', 'Soirée', false);
  });

  it('n’envoie pas de mail si le créateur n’a pas d’email', async () => {
    jwt.verify.mockReturnValue({ sub: 'evt-1', type: 'event-moderation', jti: 'j1' });
    prisma.event.findUnique.mockResolvedValue({
      id: 'evt-1',
      status: 'PENDING_REVIEW',
      title: 'Soirée',
      createdBy: { email: null },
    });
    await service.moderate('x', 'approve');
    expect(mail.sendEventDecisionEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/events/event-moderation.service.spec.ts`
Expected: FAIL (`Cannot find module './event-moderation.service'`).

- [ ] **Step 3: Implémenter le service**

Créer `src/events/event-moderation.service.ts` :

```typescript
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';

interface ModerationPayload {
  sub: string;
  type: string;
  jti: string;
}

@Injectable()
export class EventModerationService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  // Token signé porté par les liens magiques du mail équipe (durée de vie 7 jours).
  generateModerationToken(eventId: string): string {
    return this.jwtService.sign(
      { sub: eventId, type: 'event-moderation', jti: randomUUID() },
      { expiresIn: '7d' },
    );
  }

  async moderate(
    token: string,
    decision: 'approve' | 'reject',
  ): Promise<{ message: string }> {
    let payload: ModerationPayload;
    try {
      payload = this.jwtService.verify<ModerationPayload>(token);
    } catch {
      throw new UnauthorizedException('Lien de modération invalide ou expiré.');
    }

    if (payload.type !== 'event-moderation') {
      throw new ForbiddenException('Type de token non autorisé.');
    }

    // Anti-rejeu : un lien de modération ne sert qu'une fois.
    const used = await this.prisma.usedToken.findUnique({
      where: { jti: payload.jti },
    });
    if (used) {
      throw new ConflictException('Cet événement a déjà été modéré.');
    }

    const event = await this.prisma.event.findUnique({
      where: { id: payload.sub },
      include: { createdBy: true },
    });
    if (!event) {
      throw new NotFoundException('Événement introuvable.');
    }
    if (event.status !== $Enums.EventStatus.PENDING_REVIEW) {
      throw new ConflictException('Cet événement a déjà été modéré.');
    }

    const approved = decision === 'approve';
    const newStatus = approved
      ? $Enums.EventStatus.PUBLISHED
      : $Enums.EventStatus.REJECTED;

    await this.prisma.$transaction(async (tx) => {
      await tx.event.update({
        where: { id: event.id },
        data: { status: newStatus, reviewedAt: new Date() },
      });
      await tx.usedToken.create({ data: { jti: payload.jti } });
    });

    // Notifier le créateur s'il a une adresse email.
    if (event.createdBy?.email) {
      await this.mailService.sendEventDecisionEmail(
        event.createdBy.email,
        event.title,
        approved,
      );
    }

    return {
      message: approved
        ? "L'événement a été validé et publié."
        : "L'événement a été refusé.",
    };
  }
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest src/events/event-moderation.service.spec.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/events/event-moderation.service.ts src/events/event-moderation.service.spec.ts
git commit -m "feat(events): EventModerationService (tokens + validation/refus)"
```

---

### Task 6: EventsService.createEvent

**Files:**
- Create: `src/events/events.service.ts`
- Test: `src/events/events.service.spec.ts`

**Interfaces:**
- Consumes: `PrismaService`, `MailService`, `EventModerationService` (`generateModerationToken`), `CreateEventDto`, `$Enums`.
- Produces: `createEvent(userId: string, dto: CreateEventDto): Promise<{ message: string; eventId: string; status: string }>`.

- [ ] **Step 1: Écrire les tests qui échouent**

Créer `src/events/events.service.spec.ts` :

```typescript
import { BadRequestException } from '@nestjs/common';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';

function baseDto(overrides: Partial<CreateEventDto> = {}): CreateEventDto {
  return {
    title: 'Soirée',
    description: 'desc',
    startDate: '2030-01-01T20:00:00Z',
    endDate: '2030-01-01T23:00:00Z',
    location: 'Kinshasa',
    purchaseDeadline: '2030-01-01T18:00:00Z',
    category: 'CONCERT' as any,
    termsAccepted: true,
    media: [
      {
        url: 'https://cdn/a.png',
        fileKey: 'k',
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        mediaType: 'IMAGE' as any,
        isPoster: true,
      },
    ],
    ticketCategories: [
      { name: 'VIP', price: 100, ticketDesignUrl: 'https://cdn/vip.png' },
    ],
    ...overrides,
  };
}

describe('EventsService.createEvent', () => {
  let service: EventsService;
  let prisma: any;
  let mail: any;
  let moderation: any;

  beforeEach(() => {
    const createdEvent = {
      id: 'evt-1',
      title: 'Soirée',
      status: 'PENDING_REVIEW',
      startDate: new Date('2030-01-01T20:00:00Z'),
      endDate: new Date('2030-01-01T23:00:00Z'),
      purchaseDeadline: new Date('2030-01-01T18:00:00Z'),
      location: 'Kinshasa',
      category: 'CONCERT',
      description: 'desc',
      gpsLat: null,
      gpsLng: null,
      dressCode: null,
      createdById: 'user-1',
      mediaFiles: [{ url: 'https://cdn/a.png', isPoster: true }],
      ticketCategories: [
        { name: 'VIP', price: 100, ticketDesignUrl: 'https://cdn/vip.png' },
      ],
      createdBy: { id: 'user-1', email: 'u@x.com' },
    };
    prisma = {
      event: { create: jest.fn().mockResolvedValue(createdEvent) },
    };
    mail = { sendEventModerationEmail: jest.fn().mockResolvedValue(undefined) };
    moderation = { generateModerationToken: jest.fn().mockReturnValue('tok') };
    service = new EventsService(prisma, mail, moderation);
    process.env.API_BASE_URL = 'https://api.test';
    process.env.VYBE_TEAM_EMAIL = 'team@vybe.app';
  });

  it('refuse si startDate est dans le passé', async () => {
    await expect(
      service.createEvent('user-1', baseDto({ startDate: '2000-01-01T20:00:00Z' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse si endDate <= startDate', async () => {
    await expect(
      service.createEvent('user-1', baseDto({ endDate: '2030-01-01T19:00:00Z' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse si purchaseDeadline > startDate', async () => {
    await expect(
      service.createEvent('user-1', baseDto({ purchaseDeadline: '2030-01-01T21:00:00Z' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuse si aucune affiche (isPoster) n’est présente', async () => {
    const dto = baseDto();
    dto.media[0].isPoster = false;
    await expect(service.createEvent('user-1', dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('refuse si plusieurs affiches sont marquées', async () => {
    const dto = baseDto();
    dto.media = [
      { ...dto.media[0], isPoster: true },
      { ...dto.media[0], fileKey: 'k2', isPoster: true },
    ];
    await expect(service.createEvent('user-1', dto)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('crée l’événement en PENDING_REVIEW et envoie le mail de modération', async () => {
    const res = await service.createEvent('user-1', baseDto());

    // Création avec createdById serveur + status PENDING_REVIEW + médias + billets imbriqués
    const arg = prisma.event.create.mock.calls[0][0];
    expect(arg.data.createdById).toBe('user-1');
    expect(arg.data.status).toBe('PENDING_REVIEW');
    expect(arg.data.mediaFiles.create).toHaveLength(1);
    expect(arg.data.ticketCategories.create).toHaveLength(1);

    expect(moderation.generateModerationToken).toHaveBeenCalledWith('evt-1');
    expect(mail.sendEventModerationEmail).toHaveBeenCalledTimes(1);
    const mailArg = mail.sendEventModerationEmail.mock.calls[0][0];
    expect(mailArg.to).toBe('team@vybe.app');
    expect(mailArg.approveUrl).toContain('decision=approve');
    expect(mailArg.rejectUrl).toContain('decision=reject');
    expect(mailArg.posterUrl).toBe('https://cdn/a.png');

    expect(res.eventId).toBe('evt-1');
    expect(res.status).toBe('PENDING_REVIEW');
    expect(res.message).toContain('validation');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/events/events.service.spec.ts`
Expected: FAIL (`Cannot find module './events.service'`).

- [ ] **Step 3: Implémenter le service**

Créer `src/events/events.service.ts` :

```typescript
import { BadRequestException, Injectable } from '@nestjs/common';
import { $Enums } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { MailService } from 'src/mail/mail.service';
import { EventModerationService } from './event-moderation.service';
import { CreateEventDto } from './dto/create-event.dto';

@Injectable()
export class EventsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly moderationService: EventModerationService,
  ) {}

  async createEvent(userId: string, dto: CreateEventDto) {
    const start = new Date(dto.startDate);
    const end = new Date(dto.endDate);
    const deadline = new Date(dto.purchaseDeadline);
    const now = new Date();

    // ── Règles métier ───────────────────────────────────────────────
    if (start.getTime() <= now.getTime()) {
      throw new BadRequestException('La date de début doit être dans le futur.');
    }
    if (end.getTime() <= start.getTime()) {
      throw new BadRequestException(
        'La date de fin doit être postérieure à la date de début.',
      );
    }
    if (deadline.getTime() > start.getTime()) {
      throw new BadRequestException(
        "La date limite d'achat ne peut pas dépasser la date de début.",
      );
    }
    if (dto.termsAccepted !== true) {
      throw new BadRequestException('Vous devez accepter les conditions.');
    }

    const posters = dto.media.filter((m) => m.isPoster);
    if (posters.length !== 1) {
      throw new BadRequestException(
        'Vous devez fournir exactement une affiche (isPoster).',
      );
    }
    if (dto.ticketCategories.length < 1 || dto.ticketCategories.length > 4) {
      throw new BadRequestException(
        'Vous devez définir entre 1 et 4 catégories de billets.',
      );
    }

    // ── Création transactionnelle (Event + médias + catégories) ──────
    const event = await this.prisma.event.create({
      data: {
        title: dto.title,
        description: dto.description,
        startDate: start,
        endDate: end,
        location: dto.location,
        gpsLat: dto.gpsLat ?? null,
        gpsLng: dto.gpsLng ?? null,
        purchaseDeadline: deadline,
        dressCode: dto.dressCode ?? null,
        category: dto.category,
        termsAccepted: true,
        status: $Enums.EventStatus.PENDING_REVIEW,
        createdById: userId,
        mediaFiles: {
          create: dto.media.map((m) => ({
            url: m.url,
            fileKey: m.fileKey,
            fileName: m.fileName,
            mimeType: m.mimeType,
            sizeBytes: m.sizeBytes,
            mediaType: m.mediaType,
            isPoster: m.isPoster,
          })),
        },
        ticketCategories: {
          create: dto.ticketCategories.map((t) => ({
            name: t.name,
            price: t.price,
            ticketDesignUrl: t.ticketDesignUrl,
            totalStock: null, // stock illimité
            maxPerOrder: t.maxPerOrder ?? 10,
            benefits: t.benefits ?? null,
          })),
        },
      },
      include: { createdBy: true },
    });

    // ── Déclencher la modération (mail équipe avec liens magiques) ───
    const token = this.moderationService.generateModerationToken(event.id);
    const base = process.env.API_BASE_URL ?? '';
    const approveUrl = `${base}/events/moderate?token=${token}&decision=approve`;
    const rejectUrl = `${base}/events/moderate?token=${token}&decision=reject`;
    const teamEmail =
      process.env.VYBE_TEAM_EMAIL ?? process.env.SENDGRID_FROM_EMAIL!;
    const poster = posters[0];

    await this.mailService.sendEventModerationEmail({
      to: teamEmail,
      title: dto.title,
      description: dto.description,
      startDate: start,
      endDate: end,
      location: dto.location,
      gpsLat: dto.gpsLat ?? null,
      gpsLng: dto.gpsLng ?? null,
      category: dto.category,
      dressCode: dto.dressCode ?? null,
      purchaseDeadline: deadline,
      creatorLabel: event.createdBy?.email ?? userId,
      posterUrl: poster.url,
      ticketCategories: dto.ticketCategories.map((t) => ({
        name: t.name,
        price: t.price,
        ticketDesignUrl: t.ticketDesignUrl,
      })),
      approveUrl,
      rejectUrl,
    });

    return {
      message:
        "Votre événement a été soumis à validation. L'équipe Vybe vous informera de sa décision.",
      eventId: event.id,
      status: event.status,
    };
  }
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest src/events/events.service.spec.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/events/events.service.ts src/events/events.service.spec.ts
git commit -m "feat(events): EventsService.createEvent (validation + transaction + modération)"
```

---

### Task 7: Controller, module et câblage applicatif

**Files:**
- Create: `src/events/events.controller.ts`
- Create: `src/events/events.module.ts`
- Test: `src/events/events.controller.spec.ts`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes: `EventsService.createEvent`, `EventModerationService.moderate`, `JwtAuthGuard`, `RolesGuard`, `@Roles`, `CreateEventDto`, `ModerateDto`.
- Produces: routes `POST /events`, `GET /events/moderate`, `POST /events/moderate` ; `EventsModule` enregistré dans `AppModule`.

- [ ] **Step 1: Écrire le test du controller qui échoue**

Créer `src/events/events.controller.spec.ts` :

```typescript
import { EventsController } from './events.controller';

describe('EventsController', () => {
  let controller: EventsController;
  let events: any;
  let moderation: any;

  beforeEach(() => {
    events = { createEvent: jest.fn().mockResolvedValue({ eventId: 'evt-1' }) };
    moderation = { moderate: jest.fn().mockResolvedValue({ message: 'ok' }) };
    controller = new EventsController(events, moderation);
  });

  it('create délègue à EventsService avec req.user.sub', async () => {
    const req = { user: { sub: 'user-1', role: 'ADMIN' } };
    await controller.create(req as any, { title: 'x' } as any);
    expect(events.createEvent).toHaveBeenCalledWith('user-1', { title: 'x' });
  });

  it('moderatePost délègue à EventModerationService', async () => {
    await controller.moderatePost({ token: 't', decision: 'approve' } as any);
    expect(moderation.moderate).toHaveBeenCalledWith('t', 'approve');
  });

  it('moderatePage renvoie une page HTML contenant le token et la décision', () => {
    const html = controller.moderatePage('t', 'approve');
    expect(html).toContain('approve');
    expect(html).toContain('t');
    expect(html.toLowerCase()).toContain('<form');
  });
});
```

- [ ] **Step 2: Lancer le test pour vérifier l'échec**

Run: `npx jest src/events/events.controller.spec.ts`
Expected: FAIL (`Cannot find module './events.controller'`).

- [ ] **Step 3: Créer le controller**

Créer `src/events/events.controller.ts` :

```typescript
import {
  Body,
  Controller,
  Get,
  Header,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EventsService } from './events.service';
import { EventModerationService } from './event-moderation.service';
import { CreateEventDto } from './dto/create-event.dto';
import { ModerateDto } from './dto/moderate.dto';

@Controller('events')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly moderationService: EventModerationService,
  ) {}

  // Création réservée aux ADMIN (tous les comptes Vybe le sont aujourd'hui).
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @Post()
  async create(@Req() req, @Body() dto: CreateEventDto) {
    return this.eventsService.createEvent(req.user.sub, dto);
  }

  // Lien magique du mail équipe : page de confirmation (évite la validation
  // accidentelle par préchargement du lien GET). Le bouton déclenche un POST.
  @Get('moderate')
  @Header('Content-Type', 'text/html')
  moderatePage(
    @Query('token') token: string,
    @Query('decision') decision: string,
  ): string {
    const safeDecision = decision === 'reject' ? 'reject' : 'approve';
    const label = safeDecision === 'approve' ? 'VALIDER' : 'REFUSER';
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"/><title>Modération Vybe</title></head>
<body style="font-family:Arial,sans-serif;background:#0d0d0d;color:#fff;text-align:center;padding:60px;">
  <h1>Confirmer : ${label}</h1>
  <p>Confirmez votre décision de modération pour cet événement.</p>
  <form method="POST" action="/events/moderate">
    <input type="hidden" name="token" value="${token ?? ''}"/>
    <input type="hidden" name="decision" value="${safeDecision}"/>
    <button type="submit" style="padding:14px 28px;border:none;border-radius:10px;font-weight:700;cursor:pointer;background:${safeDecision === 'approve' ? '#1db954' : '#e0245e'};color:#fff;">
      Confirmer : ${label}
    </button>
  </form>
</body></html>`;
  }

  @Post('moderate')
  async moderatePost(@Body() dto: ModerateDto) {
    return this.moderationService.moderate(dto.token, dto.decision);
  }
}
```

- [ ] **Step 4: Lancer le test pour vérifier le succès**

Run: `npx jest src/events/events.controller.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Créer le module**

Créer `src/events/events.module.ts` :

```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { AuthModule } from '../auth/auth.module';
import { RolesGuard } from '../auth/guards/roles.guard';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventModerationService } from './event-moderation.service';

@Module({
  imports: [
    PrismaModule,
    MailModule,
    AuthModule, // fournit JwtAuthGuard (réexporté)
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  controllers: [EventsController],
  providers: [EventsService, EventModerationService, RolesGuard],
})
export class EventsModule {}
```

- [ ] **Step 6: Enregistrer le module dans `AppModule`**

Dans `src/app.module.ts`, ajouter l'import en haut :

```typescript
import { EventsModule } from './events/events.module';
```

Et ajouter `EventsModule` dans le tableau `imports` (après `MailModule`).

- [ ] **Step 7: Vérifier que `MailModule` exporte `MailService`**

Lire `src/mail/mail.module.ts`. Si `exports: [MailService]` est absent, l'ajouter (sinon `EventsModule` ne pourra pas injecter `MailService`).

Run: `npm run build`
Expected: build OK. Si erreur `Nest can't resolve dependencies ... MailService`, ajouter `exports: [MailService]` à `MailModule`.

- [ ] **Step 8: Lancer toute la suite de tests**

Run: `npx jest`
Expected: tous les tests passent (guard, mail, moderation, events.service, events.controller + existants).

- [ ] **Step 9: Commit**

```bash
git add src/events/events.controller.ts src/events/events.module.ts src/events/events.controller.spec.ts src/app.module.ts src/mail/mail.module.ts
git commit -m "feat(events): controller, module et câblage de la création/modération"
```

---

## Self-Review (effectué)

- **Couverture du spec :** schéma (T1), autorisation ADMIN (T2 + T7), DTOs/validation (T3),
  mail modération + décision (T4), flux modération token/anti-rejeu (T5), createEvent + règles
  métier + transaction (T6), endpoints + page de confirmation + câblage (T7). ✅
- **Placeholders :** aucun — chaque step contient le code réel. ✅
- **Cohérence des types :** `generateModerationToken(eventId)`, `moderate(token, decision)`,
  `sendEventModerationEmail(params)`, `sendEventDecisionEmail(to, title, approved)`,
  `createEvent(userId, dto)` — signatures identiques entre définition et usages. `$Enums.EventStatus`,
  `mediaFiles`/`ticketCategories` (noms de relations Prisma) cohérents avec `schema.prisma`. ✅

## Variables d'environnement à configurer

- `VYBE_TEAM_EMAIL` (destinataire modération ; fallback `SENDGRID_FROM_EMAIL`)
- `API_BASE_URL` (base des liens magiques, ex. `https://api.vybe.app`)
