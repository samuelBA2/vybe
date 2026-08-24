# Brique F — Purges automatiques (cron) — Plan d'implémentation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deux tâches cron quotidiennes qui purgent les billets expirés (ligne + médias Cloudinary) et anonymisent les comptes soft-deleted après 14 jours.

**Architecture:** Deux `@Injectable` avec un `@Cron(EVERY_DAY_AT_MIDNIGHT)`, sur le modèle exact de `src/uploads/uploads.cleanup.ts` (Logger, try/catch par élément). Le cron billets vit dans `TicketAssetModule` (déjà pourvu de Cloudinary+Prisma), le cron comptes dans `UsersModule` (auquel on ajoute `CloudinaryModule`). Un helper pur extrait le publicId Cloudinary depuis un `secure_url`. Aucune migration Prisma.

**Tech Stack:** NestJS, `@nestjs/schedule` (déjà installé + `ScheduleModule.forRoot()` actif), Prisma, Cloudinary SDK, Jest.

## Global Constraints

- **Aucune migration Prisma** — marqueur anti-retraitement via `deletionRequestedAt = null`.
- Commentaires et messages en **français** (convention du repo).
- Pattern de nettoyage : **try/catch par élément**, `logger.error(..., stack)` puis on continue ; jamais d'exception remontée au scheduler ; jamais d'échec silencieux.
- Fréquence : `CronExpression.EVERY_DAY_AT_MIDNIGHT` pour les deux crons.
- Specs par instanciation directe du service avec deps mockées (`new Service(mockPrisma, mockCloudinary)`), convention du repo (cf. `ticket-asset.service.spec.ts`). Pas de `Test.createTestingModule` pour ces specs.
- Ne pas ajouter `Co-Authored-By` dans les commits.

---

## File Structure

- `src/common/cloudinary-public-id.ts` (nouveau) — helper pur `publicIdFromUrl`.
- `src/common/cloudinary-public-id.spec.ts` (nouveau) — tests du helper.
- `src/cloudinary/cloudinary.service.ts` (modifié) — ajout `deleteAsset(publicId, resourceType)`.
- `src/cloudinary/cloudinary.service.spec.ts` (nouveau) — test de `deleteAsset`.
- `src/ticket-asset/tickets.cleanup.ts` (nouveau) — `TicketsCleanupService`.
- `src/ticket-asset/tickets.cleanup.spec.ts` (nouveau) — tests.
- `src/ticket-asset/ticket-asset.module.ts` (modifié) — enregistre le provider.
- `src/users/users.cleanup.ts` (nouveau) — `AccountsCleanupService`.
- `src/users/users.cleanup.spec.ts` (nouveau) — tests.
- `src/users/users.module.ts` (modifié) — provider + import `CloudinaryModule`.

---

## Task 1 : Helper `publicIdFromUrl`

**Files:**
- Create: `src/common/cloudinary-public-id.ts`
- Test: `src/common/cloudinary-public-id.spec.ts`

**Interfaces:**
- Consumes: rien.
- Produces: `publicIdFromUrl(secureUrl: string, keepExtension = false): string` — renvoie le publicId Cloudinary (dossier inclus). Extension retirée par défaut (assets `image`) ; `keepExtension = true` la conserve (assets `raw`, dont le publicId inclut l'extension).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// src/common/cloudinary-public-id.spec.ts
import { publicIdFromUrl } from './cloudinary-public-id';

describe('publicIdFromUrl', () => {
  it('image PNG : retire version + extension, garde le dossier', () => {
    const url = 'https://res.cloudinary.com/demo/image/upload/v1699999999/tickets/abc123.png';
    expect(publicIdFromUrl(url)).toBe('tickets/abc123');
  });

  it('raw PDF avec keepExtension : conserve l’extension', () => {
    const url = 'https://res.cloudinary.com/demo/raw/upload/v170/tickets/ticket-xyz.pdf';
    expect(publicIdFromUrl(url, true)).toBe('tickets/ticket-xyz.pdf');
  });

  it('raw PDF sans keepExtension : retire l’extension (fallback)', () => {
    const url = 'https://res.cloudinary.com/demo/raw/upload/v170/tickets/ticket-xyz.pdf';
    expect(publicIdFromUrl(url)).toBe('tickets/ticket-xyz');
  });

  it('URL sans segment /upload/ : lève une erreur explicite', () => {
    expect(() => publicIdFromUrl('https://example.com/foo.png')).toThrow('URL Cloudinary inattendue');
  });
});
```

- [ ] **Step 2: Lancer les tests → échec attendu**

Run: `npx jest src/common/cloudinary-public-id.spec.ts`
Expected: FAIL — `Cannot find module './cloudinary-public-id'`.

- [ ] **Step 3: Implémenter le helper**

```ts
// src/common/cloudinary-public-id.ts

// Extrait le publicId Cloudinary (dossier inclus) d'un secure_url.
// Ex. https://res.cloudinary.com/demo/image/upload/v1699999999/tickets/abc123.png
//   → tickets/abc123
// Les assets 'image' ont un publicId SANS extension ; les assets 'raw' (PDF) ont un
// publicId AVEC extension → passer keepExtension = true pour ceux-là.
export function publicIdFromUrl(secureUrl: string, keepExtension = false): string {
  const parts = secureUrl.split('/upload/');
  if (parts.length < 2) {
    throw new Error(`URL Cloudinary inattendue : ${secureUrl}`);
  }
  const afterUpload = parts[1].replace(/^v\d+\//, ''); // retire le segment de version v123/
  return keepExtension ? afterUpload : afterUpload.replace(/\.[^/.]+$/, ''); // retire l'extension
}
```

- [ ] **Step 4: Lancer les tests → succès attendu**

Run: `npx jest src/common/cloudinary-public-id.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/common/cloudinary-public-id.ts src/common/cloudinary-public-id.spec.ts
git commit -m "feat(cloudinary): helper publicIdFromUrl (brique F)"
```

---

## Task 2 : `CloudinaryService.deleteAsset`

**Files:**
- Modify: `src/cloudinary/cloudinary.service.ts`
- Test: `src/cloudinary/cloudinary.service.spec.ts` (nouveau)

**Interfaces:**
- Consumes: rien.
- Produces: `deleteAsset(publicId: string, resourceType: 'image' | 'raw' = 'image'): Promise<any>` — supprime un asset Cloudinary avec le bon `resource_type`. Nécessaire car `deleteImage` cible seulement les images, or les PDF sont uploadés en `resource_type: 'raw'`.

- [ ] **Step 1: Écrire le test qui échoue**

```ts
// src/cloudinary/cloudinary.service.spec.ts

// On mocke le SDK cloudinary : on teste seulement que deleteAsset relaie
// le bon resource_type à uploader.destroy (aucun appel réseau).
jest.mock('cloudinary', () => ({
  v2: { uploader: { destroy: jest.fn().mockResolvedValue({ result: 'ok' }) } },
}));
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryService } from './cloudinary.service';

describe('CloudinaryService.deleteAsset', () => {
  const service = new CloudinaryService();
  const destroy = cloudinary.uploader.destroy as jest.Mock;

  beforeEach(() => destroy.mockClear());

  it('resource_type raw pour un PDF', async () => {
    await service.deleteAsset('tickets/ticket-xyz.pdf', 'raw');
    expect(destroy).toHaveBeenCalledWith('tickets/ticket-xyz.pdf', { resource_type: 'raw' });
  });

  it('resource_type image par défaut', async () => {
    await service.deleteAsset('tickets/abc123');
    expect(destroy).toHaveBeenCalledWith('tickets/abc123', { resource_type: 'image' });
  });
});
```

- [ ] **Step 2: Lancer le test → échec attendu**

Run: `npx jest src/cloudinary/cloudinary.service.spec.ts`
Expected: FAIL — `service.deleteAsset is not a function`.

- [ ] **Step 3: Ajouter la méthode**

Dans `src/cloudinary/cloudinary.service.ts`, juste après `deleteImage` (autour de la ligne 101), ajouter :

```ts
  // Suppression resource-type-aware : 'image' (PNG/affiches/avatars) ou 'raw' (PDF).
  // deleteImage ne gère que les images ; les PDF (uploadés en resource_type 'raw')
  // exigent { resource_type: 'raw' } pour être réellement supprimés.
  async deleteAsset(publicId: string, resourceType: 'image' | 'raw' = 'image') {
    return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  }
```

- [ ] **Step 4: Lancer le test → succès attendu**

Run: `npx jest src/cloudinary/cloudinary.service.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cloudinary/cloudinary.service.ts src/cloudinary/cloudinary.service.spec.ts
git commit -m "feat(cloudinary): deleteAsset resource-type-aware (brique F)"
```

---

## Task 3 : `TicketsCleanupService` (purge des billets expirés)

**Files:**
- Create: `src/ticket-asset/tickets.cleanup.ts`
- Modify: `src/ticket-asset/ticket-asset.module.ts`
- Test: `src/ticket-asset/tickets.cleanup.spec.ts` (nouveau)

**Interfaces:**
- Consumes: `publicIdFromUrl` (Task 1), `CloudinaryService.deleteAsset` (Task 2), `PrismaService`.
- Produces: `TicketsCleanupService.purgeExpired(): Promise<void>` — supprime chaque `Ticket` où `expiresAt < now` ainsi que son PNG (`image`) et son PDF (`raw`) Cloudinary.

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// src/ticket-asset/tickets.cleanup.spec.ts
import { Logger } from '@nestjs/common';
import { TicketsCleanupService } from './tickets.cleanup';

function makePrisma(tickets: any[]) {
  return {
    ticket: {
      findMany: jest.fn().mockResolvedValue(tickets),
      delete: jest.fn().mockResolvedValue({}),
    },
  } as any;
}
function makeCloudinary() {
  return { deleteAsset: jest.fn().mockResolvedValue({}) } as any;
}

describe('TicketsCleanupService.purgeExpired', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('aucun billet expiré → aucune suppression', async () => {
    const prisma = makePrisma([]);
    const cloudinary = makeCloudinary();
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    expect(prisma.ticket.delete).not.toHaveBeenCalled();
    expect(cloudinary.deleteAsset).not.toHaveBeenCalled();
  });

  it('billet avec PNG + PDF → supprime les deux médias (bons resource_type) puis la ligne', async () => {
    const prisma = makePrisma([
      {
        id: 't1',
        ticketImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/tickets/img1.png',
        pdfUrl: 'https://res.cloudinary.com/demo/raw/upload/v1/tickets/ticket-t1.pdf',
      },
    ]);
    const cloudinary = makeCloudinary();
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    expect(cloudinary.deleteAsset).toHaveBeenCalledWith('tickets/img1', 'image');
    expect(cloudinary.deleteAsset).toHaveBeenCalledWith('tickets/ticket-t1.pdf', 'raw');
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 't1' } });
  });

  it('billet sans médias (null) → supprime la ligne sans appeler Cloudinary', async () => {
    const prisma = makePrisma([{ id: 't2', ticketImageUrl: null, pdfUrl: null }]);
    const cloudinary = makeCloudinary();
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    expect(cloudinary.deleteAsset).not.toHaveBeenCalled();
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 't2' } });
  });

  it('échec Cloudinary sur un billet → loggé, la boucle continue', async () => {
    const prisma = makePrisma([
      { id: 't1', ticketImageUrl: 'https://res.cloudinary.com/demo/image/upload/v1/tickets/a.png', pdfUrl: null },
      { id: 't2', ticketImageUrl: null, pdfUrl: null },
    ]);
    const cloudinary = makeCloudinary();
    cloudinary.deleteAsset.mockRejectedValueOnce(new Error('Cloudinary down'));
    await new TicketsCleanupService(prisma, cloudinary).purgeExpired();
    // t1 a échoué avant son delete, mais t2 est bien traité
    expect(prisma.ticket.delete).toHaveBeenCalledWith({ where: { id: 't2' } });
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Lancer les tests → échec attendu**

Run: `npx jest src/ticket-asset/tickets.cleanup.spec.ts`
Expected: FAIL — `Cannot find module './tickets.cleanup'`.

- [ ] **Step 3: Implémenter le service**

```ts
// src/ticket-asset/tickets.cleanup.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';
import { publicIdFromUrl } from 'src/common/cloudinary-public-id';

@Injectable()
export class TicketsCleanupService {
  private readonly logger = new Logger(TicketsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // Purge quotidienne des billets expirés : ligne + médias Cloudinary (PNG image, PDF raw).
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeExpired() {
    const now = new Date();
    const expired = await this.prisma.ticket.findMany({
      where: { expiresAt: { lt: now } },
      select: { id: true, ticketImageUrl: true, pdfUrl: true },
    });
    if (!expired.length) return;

    this.logger.log(`Purge de ${expired.length} billet(s) expiré(s).`);
    for (const t of expired) {
      try {
        // PNG (resource_type image) : publicId sans extension.
        if (t.ticketImageUrl) {
          await this.cloudinary.deleteAsset(publicIdFromUrl(t.ticketImageUrl), 'image');
        }
        // PDF (resource_type raw) : publicId AVEC extension.
        if (t.pdfUrl) {
          await this.cloudinary.deleteAsset(publicIdFromUrl(t.pdfUrl, true), 'raw');
        }
        await this.prisma.ticket.delete({ where: { id: t.id } });
      } catch (err) {
        // Un échec isolé ne bloque pas les autres ; réessayé au prochain passage.
        this.logger.error(
          `Échec purge billet ${t.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }
}
```

- [ ] **Step 4: Enregistrer le provider**

Dans `src/ticket-asset/ticket-asset.module.ts`, ajouter l'import et le provider (Cloudinary + Prisma sont déjà importés) :

```ts
import { Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { CloudinaryModule } from 'src/cloudinary/cloudinary.module';
import { TicketAssetService } from './ticket-asset.service';
import { TicketsCleanupService } from './tickets.cleanup';

@Module({
    imports: [PrismaModule, CloudinaryModule],
    providers: [TicketAssetService, TicketsCleanupService],
    exports: [TicketAssetService],
})
export class TicketAssetModule {}
```

- [ ] **Step 5: Lancer les tests → succès attendu**

Run: `npx jest src/ticket-asset/tickets.cleanup.spec.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/ticket-asset/tickets.cleanup.ts src/ticket-asset/tickets.cleanup.spec.ts src/ticket-asset/ticket-asset.module.ts
git commit -m "feat(tickets): cron purge des billets expirés (brique F)"
```

---

## Task 4 : `AccountsCleanupService` (anonymisation des comptes soft-deleted)

**Files:**
- Create: `src/users/users.cleanup.ts`
- Modify: `src/users/users.module.ts`
- Test: `src/users/users.cleanup.spec.ts` (nouveau)

**Interfaces:**
- Consumes: `CloudinaryService.deleteAsset` (Task 2), `PrismaService`.
- Produces: `AccountsCleanupService.purgeSoftDeleted(): Promise<void>` — anonymise chaque `User` avec `isValid=false` et `deletionRequestedAt < now-14j`, et remet `deletionRequestedAt=null` (marqueur de finalisation).

- [ ] **Step 1: Écrire les tests qui échouent**

```ts
// src/users/users.cleanup.spec.ts
import { Logger } from '@nestjs/common';
import { AccountsCleanupService } from './users.cleanup';

function makePrisma(users: any[]) {
  return {
    user: {
      findMany: jest.fn().mockResolvedValue(users),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}
function makeCloudinary() {
  return { deleteAsset: jest.fn().mockResolvedValue({}) } as any;
}

describe('AccountsCleanupService.purgeSoftDeleted', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sélectionne isValid=false ET deletionRequestedAt < cutoff', async () => {
    const prisma = makePrisma([]);
    await new AccountsCleanupService(prisma, makeCloudinary()).purgeSoftDeleted();
    const where = prisma.user.findMany.mock.calls[0][0].where;
    expect(where.isValid).toBe(false);
    expect(where.deletionRequestedAt.lt).toBeInstanceOf(Date);
  });

  it('aucun compte éligible → aucune action', async () => {
    const prisma = makePrisma([]);
    const cloudinary = makeCloudinary();
    await new AccountsCleanupService(prisma, cloudinary).purgeSoftDeleted();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(cloudinary.deleteAsset).not.toHaveBeenCalled();
  });

  it('compte éligible → efface les champs perso + deletionRequestedAt=null', async () => {
    const prisma = makePrisma([{ id: 'u1', avatarPublicId: null }]);
    await new AccountsCleanupService(prisma, makeCloudinary()).purgeSoftDeleted();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {
        email: null,
        phone: null,
        hashedPassword: null,
        firstname: null,
        lastname: null,
        avatarUrl: null,
        avatarPublicId: null,
        deletionRequestedAt: null,
      },
    });
  });

  it('compte avec avatar → supprime l’avatar Cloudinary (image)', async () => {
    const prisma = makePrisma([{ id: 'u1', avatarPublicId: 'avatars/u1' }]);
    const cloudinary = makeCloudinary();
    await new AccountsCleanupService(prisma, cloudinary).purgeSoftDeleted();
    expect(cloudinary.deleteAsset).toHaveBeenCalledWith('avatars/u1', 'image');
  });

  it('échec sur un compte → loggé, la boucle continue', async () => {
    const prisma = makePrisma([
      { id: 'u1', avatarPublicId: 'avatars/u1' },
      { id: 'u2', avatarPublicId: null },
    ]);
    const cloudinary = makeCloudinary();
    cloudinary.deleteAsset.mockRejectedValueOnce(new Error('Cloudinary down'));
    await new AccountsCleanupService(prisma, cloudinary).purgeSoftDeleted();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'u2' } }),
    );
    expect(Logger.prototype.error).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Lancer les tests → échec attendu**

Run: `npx jest src/users/users.cleanup.spec.ts`
Expected: FAIL — `Cannot find module './users.cleanup'`.

- [ ] **Step 3: Implémenter le service**

```ts
// src/users/users.cleanup.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { CloudinaryService } from 'src/cloudinary/cloudinary.service';

// Délai de grâce après la demande de suppression avant anonymisation définitive.
const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

@Injectable()
export class AccountsCleanupService {
  private readonly logger = new Logger(AccountsCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cloudinary: CloudinaryService,
  ) {}

  // Anonymisation quotidienne (RGPD) des comptes soft-deleted à J+14.
  // La ligne et ses relations (orders, events...) sont conservées ; seules les
  // données personnelles sont effacées. deletionRequestedAt=null marque la
  // finalisation → le compte est exclu des passages suivants.
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async purgeSoftDeleted() {
    const cutoff = new Date(Date.now() - GRACE_PERIOD_MS);
    const accounts = await this.prisma.user.findMany({
      where: { isValid: false, deletionRequestedAt: { lt: cutoff } },
      select: { id: true, avatarPublicId: true },
    });
    if (!accounts.length) return;

    this.logger.log(`Anonymisation de ${accounts.length} compte(s) soft-deleted.`);
    for (const u of accounts) {
      try {
        if (u.avatarPublicId) {
          await this.cloudinary.deleteAsset(u.avatarPublicId, 'image');
        }
        await this.prisma.user.update({
          where: { id: u.id },
          data: {
            email: null, // @unique → libéré pour une future ré-inscription
            phone: null, // @unique → idem
            hashedPassword: null,
            firstname: null,
            lastname: null,
            avatarUrl: null,
            avatarPublicId: null,
            deletionRequestedAt: null, // marqueur : compte finalisé
          },
        });
      } catch (err) {
        // Un échec isolé ne bloque pas les autres ; réessayé au prochain passage.
        this.logger.error(
          `Échec anonymisation compte ${u.id}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }
  }
}
```

- [ ] **Step 4: Enregistrer le provider + importer `CloudinaryModule`**

Modifier `src/users/users.module.ts` :

```ts
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { PrismaModule } from '../prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { OtpModule } from 'src/otp/otp.module';
import { JwtModule } from '@nestjs/jwt';
import { CloudinaryModule } from 'src/cloudinary/cloudinary.module';
import { AccountsCleanupService } from './users.cleanup';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AccountsCleanupService],
  imports: [
    PrismaModule,
    AuthModule,
    OtpModule,
    CloudinaryModule,
    JwtModule.register({ secret: process.env.JWT_SECRET }),
  ],
  exports: [UsersService],
})
export class UsersModule {}
```

- [ ] **Step 5: Lancer les tests → succès attendu**

Run: `npx jest src/users/users.cleanup.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/users/users.cleanup.ts src/users/users.cleanup.spec.ts src/users/users.module.ts
git commit -m "feat(users): cron anonymisation des comptes soft-deleted à J+14 (brique F)"
```

---

## Task 5 : Vérification globale (build + suite complète)

**Files:** aucun changement de code — vérification d'intégration.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: build OK, aucune erreur TypeScript (les nouveaux providers résolvent bien leurs deps ; `UsersModule` importe `CloudinaryModule`).

- [ ] **Step 2: Suite complète**

Run: `npm test`
Expected: PASS — toutes les suites vertes, y compris les nouvelles specs des Tasks 1–4 (helper, deleteAsset, tickets.cleanup, users.cleanup).

- [ ] **Step 3: Vérification manuelle Cloudinary raw (point ouvert de la spec)**

La forme du publicId attendu par `destroy` pour un asset `raw` (avec/sans extension) est un point à confirmer sur un vrai billet. Deux façons :
- soit purger un billet réel expiré en staging et vérifier dans le dashboard Cloudinary que le PDF a bien disparu ;
- soit appeler manuellement `deleteAsset('tickets/ticket-<id>.pdf', 'raw')` sur un PDF de test.

Si la suppression du PDF échoue silencieusement (asset toujours présent), inverser le `keepExtension` pour le PDF dans `tickets.cleanup.ts` (`publicIdFromUrl(t.pdfUrl)` sans `true`). Le PNG (image) n'est pas concerné.

---

## Self-Review (fait pendant la rédaction)

- **Couverture spec** : purge billets (Task 3), anonymisation comptes (Task 4), marqueur `deletionRequestedAt=null` (Task 4 Step 3 + test), `deleteAsset` raw/image (Task 2), extraction publicId depuis URL (Task 1), fréquence quotidienne (crons Task 3/4), placement modules + import `CloudinaryModule` (Task 3 Step 4, Task 4 Step 4), aucune migration (aucune tâche Prisma), tests par service (Tasks 1–4), point ouvert Cloudinary raw (Task 5 Step 3) — tous couverts.
- **Placeholders** : aucun ; tout le code est fourni.
- **Cohérence des types** : `publicIdFromUrl(url, keepExtension?)`, `deleteAsset(publicId, resourceType?)`, `purgeExpired()`, `purgeSoftDeleted()` identiques entre définition, usage et tests. Les données `select` (`id`, `ticketImageUrl`, `pdfUrl` ; `id`, `avatarPublicId`) correspondent aux champs réels du schéma.
- **Écart assumé** : `keepExtension = true` pour le PDF raw est le comportement Cloudinary attendu (publicId raw inclut l'extension), à confirmer par la vérif manuelle Task 5 Step 3.
