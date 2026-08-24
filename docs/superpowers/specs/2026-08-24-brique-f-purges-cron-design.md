# Brique F — Purges automatiques (billets expirés + comptes soft-deleted)

**Date** : 2026-08-24
**Branche** : `feat/agent-creation-login-scanTicket`
**Statut** : spec validée, prêt pour le plan d'implémentation

## Objectif

Deux tâches planifiées (cron) **indépendantes**, réunies sous le thème « nettoyage
automatique », pour empêcher l'accumulation indéfinie de données périmées :

1. **Billets expirés** — les `Ticket` dont `expiresAt < now` s'accumulent en base
   (le scan les rejette déjà à la volée, mais rien ne les supprime). On les purge,
   ligne **et** médias Cloudinary associés.
2. **Comptes soft-deleted** — finaliser le flow de suppression de compte : un `User`
   avec `isValid = false` dont la demande de suppression date de plus de 14 jours a
   dépassé son délai de grâce. On **anonymise** (RGPD) sans supprimer la ligne.

L'infrastructure est déjà en place : `@nestjs/schedule` installé,
`ScheduleModule.forRoot()` actif dans `app.module.ts`, et un pattern de référence
existant à suivre : `src/uploads/uploads.cleanup.ts`.

## Portée (V1)

- Cron quotidien de purge des billets expirés (ligne + PNG + PDF Cloudinary).
- Cron quotidien d'anonymisation des comptes soft-deleted à J+14.
- Un service de cleanup par cible, chacun enregistré comme provider dans son module
  existant.

**Hors périmètre** (YAGNI) :
- Endpoint de récupération de compte (annuler la suppression avant J+14) — flow
  distinct, non implémenté.
- Notification email « votre compte va être supprimé » avant l'échéance.
- Purge des `Order`/`Event` — conservés (historique transactionnel).
- Configuration de la fréquence ou du délai de grâce via env — valeurs en dur.
- Job de rattrapage à la demande / endpoint admin de déclenchement manuel.

## Décisions structurantes (validées en brainstorming)

1. **Billets** : hard-delete de la ligne `Ticket` **et** des médias Cloudinary.
2. **Comptes** : **anonymisation** (efface les données personnelles, garde la ligne
   et ses relations `orders`/`events`… → aucun problème de clé étrangère, conforme
   RGPD « droit à l'effacement + conservation des registres »).
3. **Marqueur anti-retraitement (comptes)** : **repurposer `deletionRequestedAt`**.
   Après anonymisation, on remet `deletionRequestedAt = null`. La requête de
   sélection exclut alors naturellement les comptes déjà finalisés. **Aucune
   migration** (aligné sur la contrainte base Neon partagée).
4. **Fréquence** : quotidienne (`CronExpression.EVERY_DAY_AT_MIDNIGHT`) pour les deux.

## Tâche 1 — Purge des billets expirés

### Fichier
`src/ticket-asset/tickets.cleanup.ts` — `TicketsCleanupService`, provider du
`TicketAssetModule`. Il n'existe pas de module « tickets » dédié : les billets sont
gérés dans `ticket-asset` (génération/upload des visuels) et `orders`. Le module
`ticket-asset` est le foyer naturel car il **importe déjà `CloudinaryModule` et
`PrismaModule`** et manipule déjà les médias Cloudinary des billets → aucun import à
ajouter, juste enregistrer le provider. Dépendances injectées : `PrismaService`,
`CloudinaryService`.

### Logique — `@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT) async purgeExpired()`

1. `const cutoff = new Date();` (now). Sélection :
   `prisma.ticket.findMany({ where: { expiresAt: { lt: cutoff } }, select: { id, ticketImageUrl, pdfUrl } })`.
2. Si vide → `return`.
3. `logger.log(...)` du nombre de billets à purger.
4. Boucle, **un try/catch par billet** (un échec isolé ne bloque pas les autres ;
   rien de silencieux — on logge l'erreur et on continue, le billet sera réessayé au
   prochain passage) :
   - supprimer le **PNG** : `deleteAsset(publicId, 'image')` où `publicId` est extrait
     de `ticketImageUrl` (voir *Extraction du publicId* ci-dessous) ;
   - supprimer le **PDF** : `deleteAsset(publicId, 'raw')` où `publicId` est extrait
     de `pdfUrl` — **le PDF a été uploadé en `resource_type: 'raw'`, sa suppression
     exige `resource_type: 'raw'`** ;
   - supprimer la ligne : `prisma.ticket.delete({ where: { id } })`.
   - Médias `null` (billet sans visuel généré) : sauter l'appel Cloudinary
     correspondant, supprimer quand même la ligne.

L'`Order` parent est conservé.

### Extension nécessaire de `CloudinaryService`

`deleteImage(publicId)` appelle `destroy(publicId)` en `resource_type: 'image'` par
défaut → **inutilisable tel quel pour le PDF (raw)**. Ajouter une méthode
resource-type-aware (amélioration ciblée justifiée par cette brique) :

```ts
async deleteAsset(publicId: string, resourceType: 'image' | 'raw' = 'image') {
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
}
```

`deleteImage` peut rester (utilisé ailleurs) ou déléguer à `deleteAsset`.

### Extraction du publicId depuis un `secure_url`

Le `Ticket` ne stocke **que** le `secure_url` (pas le publicId). Le publicId du PNG
est généré aléatoirement par Cloudinary → seule l'URL le contient. On l'extrait de
façon uniforme pour les deux médias.

Forme d'une URL Cloudinary :
`https://res.cloudinary.com/<cloud>/<resource_type>/upload/v<version>/<folder>/<name>.<ext>`

Le publicId = tout ce qui suit `/upload/v<version>/`, **extension retirée**
(dossier inclus, ex. `tickets/ticket-<id>`). Helper pur, testable isolément :

```ts
// Renvoie le publicId Cloudinary (dossier inclus, sans extension) depuis un secure_url.
function publicIdFromUrl(secureUrl: string): string {
  const afterUpload = secureUrl.split('/upload/')[1];        // v123/tickets/xxx.png
  const noVersion = afterUpload.replace(/^v\d+\//, '');       // tickets/xxx.png
  return noVersion.replace(/\.[^/.]+$/, '');                  // tickets/xxx
}
```

> Point à valider pendant le plan : pour un asset `raw` (PDF), confirmer que le
> publicId attendu par `destroy` correspond bien à la valeur extraite (sans
> extension). Le PDF a un public_id déterministe `tickets/ticket-<id>` (uploadé avec
> `public_id: ticket-<id>` + `format: 'pdf'`) ; si `destroy` raw attend l'extension,
> ajuster le helper pour le cas raw. Un test d'intégration léger ou une vérif manuelle
> sur un billet réel tranchera.

## Tâche 2 — Purge (anonymisation) des comptes soft-deleted

### Fichier
`src/users/users.cleanup.ts` — `AccountsCleanupService`, provider du `UsersModule`.
Dépendances : `PrismaService`, `CloudinaryService`. **`UsersModule` n'importe pas
encore `CloudinaryModule`** → l'ajouter à ses `imports`.

### Logique — `@Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT) async purgeSoftDeleted()`

1. `const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);` (J-14).
   Sélection :
   `prisma.user.findMany({ where: { isValid: false, deletionRequestedAt: { lt: cutoff } }, select: { id, avatarPublicId } })`.
   - Le filtre `deletionRequestedAt: { lt: cutoff }` exclut automatiquement `null` →
     un compte déjà anonymisé (`deletionRequestedAt = null`) n'est jamais re-traité.
2. Si vide → `return`.
3. `logger.log(...)` du nombre de comptes à anonymiser.
4. Boucle, **un try/catch par compte** :
   - si `avatarPublicId` : `cloudinary.deleteAsset(avatarPublicId, 'image')`
     (l'avatar est une image ; le `User` stocke déjà son publicId → pas de parsing) ;
   - `prisma.user.update({ where: { id }, data: { ... } })` avec l'anonymisation :

```ts
{
  email: null,               // @unique — nuller LIBÈRE l'identifiant pour ré-inscription
  phone: null,               // @unique — idem
  hashedPassword: null,
  firstname: null,
  lastname: null,
  avatarUrl: null,
  avatarPublicId: null,
  // isValid reste false → connexion impossible
  deletionRequestedAt: null, // MARQUEUR : finalisé, exclu des prochains passages
}
```

La ligne `User` et toutes ses relations (`orders`, `events`, `agentAccess`,
`participations`) sont conservées → aucun risque de contrainte FK.

### Invariant identifiant du compte anonymisé
`(isValid = false, deletionRequestedAt = null)` identifie de façon unique un compte
finalisé (un soft-delete frais a toujours `deletionRequestedAt != null`). Rien dans
le code actuel ne dépend de `deletionRequestedAt` après purge (le flow de
récupération n'est pas implémenté).

## Tests

Un spec par service (mock `PrismaService` + `CloudinaryService`), sans vrai cron ni
vraie base — on appelle directement la méthode publique.

**`tickets.cleanup.spec.ts`** :
- aucun billet expiré → aucune suppression, aucun appel Cloudinary ;
- billets expirés → `delete` appelé par billet + `deleteAsset('image')` et
  `deleteAsset('raw')` avec les bons publicId extraits ;
- billet avec `pdfUrl`/`ticketImageUrl` `null` → saute l'appel Cloudinary concerné,
  supprime quand même la ligne ;
- échec Cloudinary sur un billet → loggé, la boucle continue sur les suivants ;
- `publicIdFromUrl` : cas image et cas raw (test unitaire dédié du helper).

**`users.cleanup.spec.ts`** :
- aucun compte éligible (dont un compte `isValid=false` mais `deletionRequestedAt`
  récent, et un compte déjà anonymisé `deletionRequestedAt=null`) → aucune action ;
- compte éligible → `update` avec tous les champs perso à `null` + `deletionRequestedAt: null` ;
- compte avec `avatarPublicId` → `deleteAsset(avatarPublicId, 'image')` appelé ;
  compte sans avatar → pas d'appel Cloudinary ;
- échec sur un compte → loggé, la boucle continue.

## Gestion des erreurs

Même philosophie que `UploadsCleanupService` : try/catch **par élément**, on logge
(`logger.error` avec la stack) et on continue. Un échec isolé (Cloudinary
indisponible, ligne verrouillée) ne bloque pas le reste du lot et sera réessayé au
passage suivant. Aucune exception ne remonte pour ne pas faire échouer le scheduler.

## Fichiers touchés (récapitulatif)

- **Nouveau** `src/ticket-asset/tickets.cleanup.ts` + `.spec.ts`
- **Nouveau** `src/users/users.cleanup.ts` + `.spec.ts`
- **Modifié** `src/cloudinary/cloudinary.service.ts` — ajout `deleteAsset(publicId, resourceType)`
- **Modifié** `src/ticket-asset/ticket-asset.module.ts` — enregistrer `TicketsCleanupService`
  (Cloudinary + Prisma déjà importés)
- **Modifié** `src/users/users.module.ts` — enregistrer `AccountsCleanupService` **et
  ajouter `CloudinaryModule` aux imports**
- **Aucune migration Prisma.**
