# Recap — Audit de sécurité Vybe (backend NestJS)

> À coller dans une nouvelle conversation pour reprendre le travail sans perdre le contexte.

## Contexte du projet
- **Vybe** : backend NestJS (TypeScript) + Prisma + PostgreSQL pour une billetterie d'événements.
- Auth OTP-first (email via SendGrid, SMS via Twilio), JWT access/refresh, refresh en cookie httpOnly.
- Commentaires et messages d'erreur en **français**.
- **Instruction impérative** : ne jamais ajouter `Co-Authored-By` dans les messages de commit git.

## Objectif en cours
Application, un correctif à la fois, des findings d'un audit de sécurité OWASP. Pour chaque correctif, expliquer *ce qui a été modifié* et *pourquoi c'était un problème*.

## Correctifs DÉJÀ appliqués ✅
- **C2 — Endpoint SMS public** : supprimé `sms.controller.ts` + `sms.controller.spec.ts` ; retiré `controllers` de `sms.module.ts`. (Empêchait l'abus Twilio non authentifié.)
- **C3 — Guard access token** : `JwtAuthGuard` vérifie `payload.type === 'access'` ; corrigé un bug de `signToken` (l'access token était signé `type: 'refresh'` avec payload imbriqué).
- **C4 — Rate limiting** : `ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }])` global dans `app.module.ts` + `APP_GUARD` ; `@Throttle` serré sur les routes sensibles (send: 3, verify: 5).
- **H1 — Ordre des routes** : routes statiques (`mine`, `moderate`) déclarées avant `:id` (déjà correct).
- **H2 — XSS réfléchi** : ajout de `escapeHtml()` dans `events.controller.ts`, appliqué à `value="${escapeHtml(token)}"` dans `moderatePage`. ✅ COMPLET
- **H3 — Changement d'identifiant** : `requestIdentifierChange` vérifie la disponibilité + envoie l'OTP sur le bon canal (email→mail, phone→SMS).
- **H4 — Type de token** : `verifyIdentifierChange` vérifie `payload.type === 'identifier-change'` et `payload.sub === userId`.
- **H5 — Anti-énumération login** : `loginEmail` ET `loginPhone` n'envoient l'OTP que si le compte existe/valide, mais renvoient toujours le même message + tempToken. try/catch autour de l'envoi pour masquer l'état cooldown/blocage. ✅ COMPLET
- **B5 — req.user.sub** : remplacé `req.user.id` par `req.user.sub` dans `users.controller.ts` (changePassword, identifier, deletion).
- **Refresh** : corrigé un bug de dead-code (return prématuré avant le check `user.isValid`), un soft-deleted ne peut plus refresh.

- **M3 — Filtre d'exception Prisma** : créé `src/common/filters/prisma-exception.filter.ts` (`@Catch(Prisma.PrismaClientKnownRequestError)`), activé via `app.useGlobalFilters()` dans `main.ts`. Logge le détail côté serveur, renvoie un message générique au client (P2002→409, P2025→404, défaut→400). Empêche la fuite du schéma DB et renforce l'anti-énumération. ✅ COMPLET
- **M3+ — AllExceptionsFilter** : créé `src/common/filters/all-exceptions.filter.ts` (`@Catch()` catch-all). Préserve les `HttpException` (validation/401/404), logge la stack côté serveur et renvoie un `500` générique pour tout le reste. Enregistré APRÈS le filtre Prisma dans `main.ts` (ordre critique : NestJS prend le premier `@Catch` qui matche). ✅ COMPLET

- **C1 — Fallback `'default_secret'`** : supprimé. Vérifié par grep : plus aucune occurrence de `default_secret`, le secret vient de `JWT_SECRET` (via `config.get` / `process.env`). ✅ COMPLET
- **M4 — En-têtes de sécurité HTTP absents** : installé `helmet` (8.2.0), branché `app.use(helmet(...))` en tout premier dans `bootstrap()` (`main.ts`). Ajout HSTS, nosniff, X-Frame-Options, masque X-Powered-By. Réglage `crossOriginResourcePolicy: 'cross-origin'` (front sur origine différente, CORS gère déjà les origines). ✅ COMPLET
- **M4b — CSP page de modération** : surcharge locale via `@Header('Content-Security-Policy', ...)` sur `moderatePage` (`events.controller.ts`) : `style-src 'self' 'unsafe-inline'` pour autoriser les styles inline de la page, `script-src` reste verrouillé (aucun JS), `form-action 'self'`, `frame-ancestors 'none'`. N'assouplit QUE cette route, la CSP stricte globale de Helmet reste active partout ailleurs. ✅ COMPLET

## Correctifs NON encore appliqués ⏳
- **H6** — Tous les users créés avec rôle `ADMIN` (devrait être `USER` par défaut). *Note : `completeProfile` crée maintenant `role: USER` — à revérifier vs CLAUDE.md.*
- **M1** — `emailVerified` à l'inscription email.
- **M2** — OTP stocké en clair en base (devrait être haché).

## Livrables
- `docs/regles-dev.md` — fichier de règles préventives (5 sections : Sécurité, BDD/Prisma, Architecture NestJS, Gestion d'erreurs, Conventions).
- `docs/recap-audit-securite.md` — ce fichier.

## Vérification
Après chaque correctif : `npx tsc --noEmit -p tsconfig.json` (doit sortir EXIT 0).

## Prochaine étape suggérée
Appliquer **C1** (supprimer le fallback `'default_secret'` dans `jwt.strategy`), puis M2 (hachage des OTP).
