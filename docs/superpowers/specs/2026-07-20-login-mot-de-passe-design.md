# Design — Connexion par mot de passe + verrou progressif + mot de passe oublié

Date : 2026-07-20
Statut : validé (brainstorming), prêt pour plan d'exécution
Portée : backend NestJS (`~/vybe`) + frontend React (`~/vybeFrontend`)

## Objectif

Remplacer la connexion actuelle (OTP à usage unique envoyé par mail/SMS) par une
connexion **identifiant + mot de passe** vérifié en base. Ajouter un verrou
progressif anti-brute-force et un flux « mot de passe oublié » basé sur OTP.

L'**inscription** (OTP-first) et le **refresh de session** ne changent pas.

## Décisions validées

- Connexion par **mot de passe uniquement** — les endpoints de login par OTP sont **supprimés**.
- Verrou **progressif** : chaque série de **5 mots de passe faux** déclenche un verrou.
  Palier 1 → **5 min**, palier 2 → **1 h**, palier 3 et suivants → **12 h**.
  Le palier ne redescend **que** sur une connexion réussie (remise à zéro compteur + palier).
- Pendant un verrou actif : le client n'affiche **que** le message de blocage + un compte
  à rebours. Le « mot de passe oublié » est **inaccessible** ; seul l'écoulement du
  compte à rebours débloque (backend refuse aussi `forgot`/`reset` sous verrou).
- « Mot de passe oublié » : l'OTP part vers le **canal que possède le compte**
  (son unique identifiant email OU téléphone) — pas de sélecteur.
- Politique de mot de passe : **inchangée** (min 8, 1 majuscule, 1 minuscule, 1 chiffre,
  1 spécial `@$!%*?&`) — réutilisée telle quelle au reset.

## Section 1 — Stockage du verrou (option A)

Trois champs ajoutés au modèle `User` (Prisma) :

```
failedLoginAttempts Int       @default(0)   // compteur de la série en cours (0..5)
loginLockLevel      Int       @default(0)   // palier atteint : 0 aucun, 1→5min, 2→1h, 3+→12h
loginLockedUntil    DateTime?               // fin du verrou en cours ; null = pas de verrou
```

Migration : `npx prisma migrate dev --name add_login_lockout`.
Aucun back-fill : les comptes existants ont déjà un `hashedPassword` (posé à
`completeProfile`) et les nouveaux champs ont des défauts.

## Section 2 — Connexion par mot de passe

**Nouvel endpoint** `POST /auth/login` — corps `{ identifier, password }`.
`identifier` = email ou téléphone (détection du type côté service).
Throttle applicatif en plus du verrou (ex. `@Throttle 10/min`).

Logique `AuthService.login` :

1. Retrouver le user par `email` OU `phone`. Absent / `!isValid` / `hashedPassword`
   nul → `401 « Identifiants invalides »` générique, **sans** compteur (on ne
   verrouille pas un compte fantôme, on ne révèle pas son inexistence).
   Comparer contre un **hash factice** pour l'égalité des temps de réponse.
2. Si `loginLockedUntil > maintenant` → `403` message de blocage + `lockedUntil`
   (pour le compte à rebours). Le mot de passe n'est **pas** comparé.
3. `bcrypt.compare(password, hashedPassword)` :
   - **Faux** → `failedLoginAttempts += 1`. Si le compteur atteint **5** :
     `loginLockLevel += 1`, poser `loginLockedUntil` selon le palier
     (1 → +5 min, 2 → +1 h, 3+ → +12 h), remettre `failedLoginAttempts` à 0.
     Réponse : `401` « Mot de passe incorrect, il te reste N essai(s) », ou —
     si le seuil vient d'être franchi — `403` message de verrou + `lockedUntil`.
   - **Bon** → remettre à zéro `failedLoginAttempts`, `loginLockLevel`,
     `loginLockedUntil`, émettre la paire access/refresh (`signToken`) et poser
     le cookie refresh (identique à l'actuel `verifyLoginEmailOtp`).

## Section 3 — Mot de passe oublié (OTP)

Réutilise `OtpService` (envoi + blocage OTP existants) et le pattern tempToken JWT.
**Inaccessible sous verrou actif** (règle validée).

**Étape 1 — `POST /auth/password/forgot`** — corps `{ identifier }`.
1. Retrouver le user. Sous verrou actif → `403` verrou + `lockedUntil`.
2. Existant + valide → `OtpService.sendLoginEmailOtp` ou `sendLoginPhoneOtp` selon
   le type d'identifiant (cooldown + anti-bombing déjà gérés).
3. Réponse **uniforme** quelle que soit l'existence :
   `{ message: "Si un compte existe, un code a été envoyé.", token }` où `token`
   est un JWT 10 min `{ identifier, purpose: 'password-reset', jti }`.

**Étape 2 — `POST /auth/password/reset`** — header `x-temp-token` + corps
`{ otp, newPassword, confirmPassword }`.
1. Vérifier le JWT (`purpose === 'password-reset'`, non expiré) → sinon « Lien expiré ».
2. `jti` non consommé (table `UsedToken`, anti-rejeu).
3. Re-vérifier absence de verrou actif (garde-fou).
4. `OtpService.verifyOtp(identifier, otp)` (gère 5 tentatives + blocage du code).
5. `newPassword === confirmPassword` (sinon `400`) ; `newPassword` ≠ ancien
   (`bcrypt.compare`) ; règle de complexité inchangée.
6. `$transaction` : `hashedPassword = bcrypt.hash(newPassword, BCRYPT_ROUNDS)`,
   remise à zéro `failedLoginAttempts` / `loginLockLevel` / `loginLockedUntil`,
   création `UsedToken(jti)`.
7. **Pas** de connexion auto : `{ message: "Mot de passe modifié, connecte-toi." }`.
   L'utilisateur repasse par l'écran de login.

## Section 4 — Frontend

Fichiers : `src/components/vybe/Auth.tsx`, `src/services/auth.service.ts`,
`src/store/AuthContext.tsx`.

Nettoyage : suppression des méthodes `loginSendOtp` / `loginVerifyOtp` et de
l'étape OTP **de connexion** (l'OTP d'inscription reste).

Machine à états de login :
- **`login`** — champ identifiant + champ mot de passe + « Se connecter » + lien
  « Mot de passe oublié ? ». `401` mdp faux → message « il te reste N essai(s) »
  sous le champ (ressaisie, pas de changement d'écran). `403` → état `locked`.
- **`locked`** — **uniquement** message de blocage + compte à rebours calculé depuis
  `lockedUntil` (source de vérité = timestamp serveur, résistant au refresh de page).
  Formulaire et lien oublié masqués/désactivés. Fin du compte à rebours → retour `login`.
- **`forgot`** — champ identifiant + « Envoyer le code » → `POST /auth/password/forgot`,
  stocke `token`, passe à `reset`. `403` verrou → état `locked`.
- **`reset`** — `InputOTP` + nouveau mot de passe + confirmation →
  `POST /auth/password/reset` avec `x-temp-token`. Succès → message « Mot de passe
  modifié » puis retour `login`.

`AuthContext` : la méthode de login appelle `POST /auth/login` (pose le cookie refresh)
puis récupère l'utilisateur — même fin de connexion qu'aujourd'hui, entrée différente.

Compte à rebours : `useEffect` + `setInterval` décrémentant jusqu'à `lockedUntil`,
nettoyé au démontage.

## Section 5 — Sécurité, cas limites, suppression

- **Backend supprimé** : endpoints `login/email`, `login/email/verify`, `login/phone`,
  `login/phone/verify` (controller) + méthodes service `loginEmail`, `loginPhone`,
  `verifyLoginEmailOtp`, `verifyLoginPhoneOtp`. Inscription + refresh inchangés.
- **Throttling** : `@Throttle` sur `POST /auth/login` (double barrière avec le verrou).
- **Anti-énumération** : `forgot` uniforme ; login révèle « mot de passe incorrect »
  (nécessaire au compteur) mais « identifiants invalides » générique + hash factice
  quand l'identifiant n'existe pas.
- **Compte sans mot de passe** : si `hashedPassword` nul → `401` générique (pas de crash bcrypt).

## Tests

- `AuthService.login` : bon mdp ; mauvais mdp (compteur incrémente) ; franchissement
  de chaque palier (5 min / 1 h / 12 h) ; verrou actif refuse même un bon mdp ;
  remise à zéro compteur + palier sur succès ; identifiant inexistant (générique, pas de verrou).
- Flux reset : verrou actif refuse `forgot` ; OTP faux ; `newPassword` ≠ confirmation ;
  rejeu du `jti` refusé ; succès met bien à jour `hashedPassword` et remet les compteurs à zéro.

## Hors périmètre (YAGNI)

- Sélecteur de canal email/SMS pour un compte ayant les deux identifiants.
- Durcissement de la politique de mot de passe.
- Notification email/SMS informant d'un changement de mot de passe réussi.
