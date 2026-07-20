# Plan d'exécution — Connexion par mot de passe + verrou progressif + reset OTP

> **Note d'usage :** ce plan est un **guide**. Chaque tâche décrit *quoi* faire,
> *où*, *dans quel ordre* et *comment vérifier* — mais **c'est toi qui écris le code**.
> Les étapes sont cochables (`- [ ]`). Suis-les dans l'ordre : chaque tâche se
> termine par une vérification et un commit.

**Objectif :** remplacer la connexion OTP par une connexion identifiant + mot de passe,
avec verrou progressif (5 min → 1 h → 12 h) et flux « mot de passe oublié » par OTP.

**Spec de référence :** [docs/superpowers/specs/2026-07-20-login-mot-de-passe-design.md](specs/2026-07-20-login-mot-de-passe-design.md)

**Branche :** `feat/login-mot-de-passe` (déjà créée, spec déjà commitée).

## Contraintes globales

- Français pour commentaires et messages d'erreur.
- Hachage : `bcrypt` avec `BCRYPT_ROUNDS` (`src/common/constants.ts`).
- Politique mot de passe **inchangée** : min 8, 1 majuscule, 1 minuscule, 1 chiffre, 1 spécial `@$!%*?&`.
- Ne pas toucher : inscription (OTP), refresh de session, cookie refresh.
- Paliers de verrou : 1 → 5 min, 2 → 1 h, 3+ → 12 h ; déclenchés toutes les 5 tentatives faux ; remis à zéro sur connexion réussie.

## Carte des fichiers

**Backend (`~/vybe`)**
- `prisma/schema.prisma` — 3 champs de verrou sur `User` (modifier)
- `src/common/constants.ts` — durées de paliers (modifier)
- `src/auth/dto/login.dto.ts` — DTO login (créer)
- `src/auth/dto/forgot-password.dto.ts` — DTO forgot (créer)
- `src/auth/dto/reset-password.dto.ts` — DTO reset (créer)
- `src/auth/auth.service.ts` — `login`, `forgotPassword`, `resetPassword` ; suppression des 4 méthodes OTP de login (modifier)
- `src/auth/auth.controller.ts` — 3 nouveaux endpoints ; suppression des 4 anciens (modifier)
- `src/auth/dto/login-mail.dto.ts`, `login-phone.dto.ts` — supprimer (morts après nettoyage)
- `src/auth/auth.service.spec.ts` — tests unitaires (modifier/écrire)

**Frontend (`~/vybeFrontend`)**
- `src/services/auth.service.ts` — `login`, `forgotPassword`, `resetPassword` ; suppression `loginSendOtp`/`loginVerifyOtp` (modifier)
- `src/types/api.ts` — types de requêtes/réponses login/reset (modifier)
- `src/components/vybe/Auth.tsx` — machine à états `login`/`locked`/`forgot`/`reset` (modifier)

---

## PHASE BACKEND

### Tâche 1 : Migration — champs de verrou sur `User`

**Fichiers :** `prisma/schema.prisma` (modifier)

- [ ] **Étape 1 :** dans le modèle `User`, ajoute trois champs :
  - `failedLoginAttempts Int @default(0)`
  - `loginLockLevel Int @default(0)`
  - `loginLockedUntil DateTime?`
- [ ] **Étape 2 :** génère et applique la migration :
  Run : `npx prisma migrate dev --name add_login_lockout`
  Attendu : migration créée sous `prisma/migrations/…_add_login_lockout/` + client régénéré.
- [ ] **Étape 3 :** vérifie que le client TypeScript connaît les champs :
  Run : `npx tsc --noEmit` (ou `npm run build`) — pas d'erreur sur `failedLoginAttempts`.
- [ ] **Étape 4 :** commit.
  `git add prisma/schema.prisma prisma/migrations && git commit -m "feat(auth): champs de verrou de connexion sur User"`

### Tâche 2 : Constantes des paliers de verrou

**Fichiers :** `src/common/constants.ts` (modifier)

- [ ] **Étape 1 :** ajoute les constantes (exportées) :
  - seuil de tentatives avant verrou = `5`
  - un tableau des durées de paliers en millisecondes : `[5 min, 1 h, 12 h]`
    (5*60_000, 60*60_000, 12*60*60_000). Prévois que le palier 3 et au-delà
    réutilisent la dernière valeur (12 h).
- [ ] **Étape 2 :** commit.
  `git add src/common/constants.ts && git commit -m "chore(auth): constantes de verrou progressif"`

### Tâche 3 : DTOs (login, forgot, reset)

**Fichiers :** `src/auth/dto/login.dto.ts`, `forgot-password.dto.ts`, `reset-password.dto.ts` (créer)

Inspire-toi de `complete-profile.dto.ts` (décorateurs `class-validator` + messages FR).

- [ ] **Étape 1 — `login.dto.ts` :** champ `identifier: string` (`@IsString`, `@IsNotEmpty`) et `password: string` (`@IsString`, `@IsNotEmpty`). Pas de règle de complexité ici (on vérifie juste la présence — la complexité ne concerne QUE la création/reset).
- [ ] **Étape 2 — `forgot-password.dto.ts` :** champ `identifier: string` (`@IsString`, `@IsNotEmpty`).
- [ ] **Étape 3 — `reset-password.dto.ts` :** `otp: string` (`@IsString`, longueur 6), `newPassword: string` (recopie les décorateurs de complexité de `complete-profile.dto.ts`), `confirmPassword: string`. Réutilise le validateur croisé `newPassword === confirmPassword` s'il existe dans `complete-profile.dto.ts`, sinon compare-les dans le service.
- [ ] **Étape 4 :** `npx tsc --noEmit` — pas d'erreur.
- [ ] **Étape 5 :** commit.
  `git add src/auth/dto/login.dto.ts src/auth/dto/forgot-password.dto.ts src/auth/dto/reset-password.dto.ts && git commit -m "feat(auth): DTOs login mot de passe + reset"`

### Tâche 4 : `AuthService.login` (vérif mot de passe + verrou progressif)

**Fichiers :** `src/auth/auth.service.ts` (modifier), `src/auth/auth.service.spec.ts` (tests)

**Interfaces produites :** `login(dto: LoginDto): Promise<{ accessToken, refreshToken }>`
(même forme de retour que `signToken`, pour que le controller pose le cookie comme aujourd'hui).

- [ ] **Étape 1 — méthode utilitaire de détection d'identifiant :** décide si `identifier`
  est un email ou un téléphone (présence de `@`, ou un helper existant). Elle sert à
  faire le `findUnique({ where: { email } })` ou `{ phone }`.
- [ ] **Étape 2 — écris les tests d'abord** dans `auth.service.spec.ts`. Monte un
  `TestingModule` avec `AuthService` + providers mockés (`PrismaService`, `JwtService`,
  `SmsService`, `ConfigService`, `OtpService`) — voir un spec existant qui marche comme
  modèle de mock. Cas à couvrir :
  1. **Bon mot de passe** → renvoie access+refresh ; `prisma.user.update` appelé avec
     `failedLoginAttempts: 0, loginLockLevel: 0, loginLockedUntil: null`.
  2. **Mauvais mot de passe (sous le seuil)** → lève `UnauthorizedException` ; update
     incrémente `failedLoginAttempts`.
  3. **5e mauvais essai, palier 1** → pose `loginLockedUntil ≈ now + 5 min`,
     `loginLockLevel: 1`, `failedLoginAttempts: 0`.
  4. **Palier 2** (compte déjà à `loginLockLevel: 1`, 5 nouveaux faux) → `now + 1 h`.
  5. **Palier 3** (déjà `loginLockLevel: 2`) → `now + 12 h`.
  6. **Verrou actif** (`loginLockedUntil > now`) → lève une exception verrou **sans**
     appeler `bcrypt.compare` ni chercher plus loin.
  7. **Identifiant inexistant / `!isValid` / `hashedPassword` nul** → `UnauthorizedException`
     générique, **aucun** `prisma.user.update` (pas de verrou d'un compte fantôme).
- [ ] **Étape 3 :** lance les tests, vérifie qu'ils **échouent** (méthode absente).
  Run : `npx jest src/auth/auth.service.spec.ts` → FAIL.
- [ ] **Étape 4 — implémente `login`** selon la logique de la spec §2 :
  1. Trouver le user (email ou phone).
  2. Absent / `!isValid` / `!hashedPassword` → comparer contre un **hash factice**
     (une constante bcrypt pré-calculée) puis lever `UnauthorizedException('Identifiants invalides')`.
  3. `loginLockedUntil > now` → `ForbiddenException` avec le temps restant + expose `lockedUntil`.
  4. `bcrypt.compare` : si faux, incrémente ; au multiple de 5 → calcule la durée via le
     tableau de paliers (index = `loginLockLevel`, borné à la dernière valeur), pose
     `loginLockedUntil`, `loginLockLevel += 1`, `failedLoginAttempts = 0`, et renvoie le
     message adapté (essais restants ou message de verrou + `lockedUntil`).
  5. Si bon → reset des 3 champs, `signToken`.
- [ ] **Étape 5 :** relance les tests → **PASS**.
  Run : `npx jest src/auth/auth.service.spec.ts`
- [ ] **Étape 6 :** commit.
  `git add src/auth/auth.service.ts src/auth/auth.service.spec.ts && git commit -m "feat(auth): connexion par mot de passe avec verrou progressif"`

### Tâche 5 : `AuthService.forgotPassword` + `resetPassword`

**Fichiers :** `src/auth/auth.service.ts` (modifier), `auth.service.spec.ts` (tests)

**Interfaces produites :**
- `forgotPassword(dto: ForgotPasswordDto): Promise<{ message, token }>`
- `resetPassword(dto: ResetPasswordDto, token: string): Promise<{ message }>`

- [ ] **Étape 1 — tests d'abord.** Cas :
  1. `forgotPassword` sous verrou actif → exception verrou, **pas** d'envoi d'OTP.
  2. `forgotPassword` compte existant → `OtpService.sendLogin{Email|Phone}Otp` appelé ;
     renvoie un `token` JWT `purpose: 'password-reset'`.
  3. `forgotPassword` compte inexistant → **même** réponse (message + token) sans envoi (anti-énumération).
  4. `resetPassword` token invalide/expiré → exception.
  5. `resetPassword` `jti` déjà dans `UsedToken` → exception (anti-rejeu).
  6. `resetPassword` OTP faux → propage l'exception de `OtpService.verifyOtp`.
  7. `resetPassword` `newPassword ≠ confirmPassword` → `BadRequestException`.
  8. `resetPassword` succès → `prisma.$transaction` met à jour `hashedPassword`, remet
     `failedLoginAttempts/loginLockLevel/loginLockedUntil` à zéro, crée `UsedToken(jti)`.
- [ ] **Étape 2 :** `npx jest src/auth/auth.service.spec.ts` → FAIL.
- [ ] **Étape 3 — implémente** selon spec §3. Réutilise le pattern tempToken JWT
  (`randomUUID` pour le `jti`, secret `JWT_SECRET`, `expiresIn: '10m'`) et le pattern
  `UsedToken` de `completeProfile`. Détecte email/phone comme en Tâche 4 pour choisir
  `sendLoginEmailOtp` vs `sendLoginPhoneOtp` et l'argument de `verifyOtp`.
- [ ] **Étape 4 :** `npx jest src/auth/auth.service.spec.ts` → PASS.
- [ ] **Étape 5 :** commit.
  `git add src/auth/auth.service.ts src/auth/auth.service.spec.ts && git commit -m "feat(auth): mot de passe oublié (forgot + reset OTP)"`

### Tâche 6 : Controller — nouveaux endpoints + suppression des anciens

**Fichiers :** `src/auth/auth.controller.ts` (modifier)

- [ ] **Étape 1 — ajoute** trois routes (garde le pattern `@Throttle` + `setRefreshCookie`) :
  - `POST /auth/login` (`@Throttle 10/min`) → `authService.login`, puis `setRefreshCookie(res, tokens.refreshToken)`, renvoie `{ accessToken, ... }` (comme `verifyLoginEmailOtp`).
  - `POST /auth/password/forgot` (`@Throttle 3/min`) → `authService.forgotPassword`.
  - `POST /auth/password/reset` (`@Throttle 5/min`) → lit le header `x-temp-token`, appelle `authService.resetPassword(dto, token)`.
- [ ] **Étape 2 — supprime** les 4 routes OTP de login : `login/email`, `login/email/verify`,
  `login/phone`, `login/phone/verify`, et leurs imports DTO devenus inutiles.
- [ ] **Étape 3 :** `npm run build` → aucune erreur (repère les références mortes à supprimer).
- [ ] **Étape 4 — test manuel rapide** (backend lancé `npm run start:dev`) avec un compte existant :
  - `curl -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"identifier":"<email>","password":"<bon>"}'` → 200 + `accessToken`.
  - même appel avec un mauvais mot de passe → 401 « il te reste N essai(s) ».
- [ ] **Étape 5 :** commit.
  `git add src/auth/auth.controller.ts && git commit -m "feat(auth): endpoints login mot de passe + reset, suppression login OTP"`

### Tâche 7 : Nettoyage backend (méthodes + DTOs morts)

**Fichiers :** `src/auth/auth.service.ts`, `src/auth/dto/login-mail.dto.ts`, `login-phone.dto.ts` (supprimer)

- [ ] **Étape 1 :** supprime dans `auth.service.ts` les méthodes désormais inutilisées :
  `loginEmail`, `loginPhone`, `verifyLoginEmailOtp`, `verifyLoginPhoneOtp`.
- [ ] **Étape 2 :** supprime les fichiers `login-mail.dto.ts` et `login-phone.dto.ts`
  s'ils ne sont plus référencés (vérifie avec `grep -rn "LoginEmailDto\|LoginPhoneDto" src`).
- [ ] **Étape 3 :** `npm run build` → OK ; `npx jest src/auth/auth.service.spec.ts` → PASS.
- [ ] **Étape 4 :** commit.
  `git add -A src/auth && git commit -m "chore(auth): suppression du code de login OTP mort"`

---

## PHASE FRONTEND (`~/vybeFrontend`)

### Tâche 8 : Service d'auth frontend

**Fichiers :** `src/services/auth.service.ts`, `src/types/api.ts` (modifier)

- [ ] **Étape 1 — types (`api.ts`)** : ajoute les formes de payload/réponse :
  `LoginPayload { identifier; password }`, une réponse verrou `{ lockedUntil: string }`
  (le backend renvoie `lockedUntil` sur 403), `ForgotPayload { identifier }`,
  `ResetPayload { otp; newPassword; confirmPassword }`.
- [ ] **Étape 2 — `auth.service.ts`** : ajoute `login(identifier, password)` (POST `/auth/login`,
  pose l'access token via `setAccessToken(res.accessToken)` comme `loginVerifyOtp` le fait),
  `forgotPassword(identifier)` (POST `/auth/password/forgot`, renvoie `{ token }`),
  `resetPassword(otp, newPassword, confirmPassword, tempToken)` (POST `/auth/password/reset`,
  header via l'option `authToken`).
- [ ] **Étape 3 :** supprime `loginSendOtp` et `loginVerifyOtp`, et mets à jour le
  commentaire d'en-tête du fichier (le bloc « Connexion » décrit encore l'OTP).
- [ ] **Étape 4 :** `npm run build` (ou `npx tsc --noEmit`) → repère les usages morts dans `Auth.tsx` (attendu, on les traite ensuite).
- [ ] **Étape 5 :** commit.
  `git add src/services/auth.service.ts src/types/api.ts && git commit -m "feat(auth): service login mot de passe + reset"`

### Tâche 9 : Écran `login` + gestion d'erreur

**Fichiers :** `src/components/vybe/Auth.tsx` (modifier)

- [ ] **Étape 1 :** dans la machine `Step`, remplace l'étape OTP de connexion. Sur l'écran
  de login, ajoute un champ mot de passe à côté de l'identifiant + bouton « Se connecter ».
- [ ] **Étape 2 :** au submit, appelle `authService.login(...)` puis `completeLogin()`
  (contexte) pour charger l'utilisateur — même fin de parcours qu'avant.
- [ ] **Étape 3 :** gestion d'erreur : un `401` affiche le message serveur sous le champ
  (« il te reste N essai(s) »), l'utilisateur ressaisit. Un `403` → passe à l'état `locked`
  (Tâche 10) en récupérant `lockedUntil` depuis l'erreur (`ApiError` — vérifie comment le
  corps d'erreur est exposé, ajoute `lockedUntil` au parsing si besoin).
- [ ] **Étape 4 :** ajoute le lien « Mot de passe oublié ? » qui passe à l'état `forgot`.
- [ ] **Étape 5 — vérif visuelle** : lance le front (`npm run dev`) + back, connecte-toi
  avec un bon puis un mauvais mot de passe.
- [ ] **Étape 6 :** commit.
  `git add src/components/vybe/Auth.tsx && git commit -m "feat(auth): écran de connexion par mot de passe"`

### Tâche 10 : État `locked` + compte à rebours

**Fichiers :** `src/components/vybe/Auth.tsx` (modifier)

- [ ] **Étape 1 :** ajoute l'état `locked` qui affiche **uniquement** le message de blocage
  + un compte à rebours. Masque le formulaire et le lien « oublié ».
- [ ] **Étape 2 :** le compte à rebours = `useEffect` + `setInterval` (1 s) calculant
  `lockedUntil - Date.now()`. Source de vérité = `lockedUntil` serveur (résiste au refresh
  de page). Nettoie l'interval au démontage.
- [ ] **Étape 3 :** à l'expiration (reste ≤ 0), reviens automatiquement à l'état `login`.
- [ ] **Étape 4 — vérif** : force un verrou (5 mauvais essais) et observe le décompte.
- [ ] **Étape 5 :** commit.
  `git add src/components/vybe/Auth.tsx && git commit -m "feat(auth): écran de verrou avec compte à rebours"`

### Tâche 11 : États `forgot` + `reset`

**Fichiers :** `src/components/vybe/Auth.tsx` (modifier)

- [ ] **Étape 1 — `forgot`** : champ identifiant + « Envoyer le code » → `authService.forgotPassword`,
  stocke le `token` renvoyé dans l'état local, passe à `reset`. Si `403` verrou → état `locked`.
- [ ] **Étape 2 — `reset`** : réutilise `InputOTP` (déjà importé) + nouveau mot de passe +
  confirmation, avec le schéma zod de complexité existant (celui du `profileSchema`, ligne ~23).
  Submit → `authService.resetPassword(otp, newPassword, confirmPassword, token)`.
- [ ] **Étape 3 :** succès → message « Mot de passe modifié » puis retour à `login`.
- [ ] **Étape 4 — vérif de bout en bout** : verrou expiré → « mot de passe oublié » →
  OTP reçu (mail/SMS) → nouveau mot de passe → reconnexion réussie avec le nouveau.
- [ ] **Étape 5 :** commit.
  `git add src/components/vybe/Auth.tsx && git commit -m "feat(auth): mot de passe oublié et réinitialisation"`

---

## Vérification finale (avant merge)

- [ ] Backend : `npm run build` OK, `npx jest src/auth/auth.service.spec.ts` PASS.
- [ ] Frontend : `npm run build` OK.
- [ ] Parcours manuel complet : connexion (bon/mauvais), franchissement d'un palier de
  verrou + décompte, « mot de passe oublié » → reset → reconnexion.
- [ ] `grep -rn "login/email\|loginSendOtp\|verifyLoginEmailOtp" src` → **aucun** résultat (mort supprimé).
- [ ] Finalisation de la branche via la skill `superpowers:finishing-a-development-branch`.
