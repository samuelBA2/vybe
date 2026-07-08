# Règles de développement STRICTES — Vybe

Toute IA assistante (et tout développeur) DOIT respecter ces règles. Elles découlent
de failles réelles constatées en audit sur ce backend NestJS + Prisma + PostgreSQL.
Chaque règle est impérative et vérifiable.

---

## 1. Sécurité

- Les secrets (`JWT_SECRET`, `TWILIO_*`, `SENDGRID_*`, `DATABASE_URL`) NE DOIVENT
  JAMAIS avoir de valeur de repli en dur. L'application DOIT échouer au démarrage
  si un secret requis est absent.
  ```
  ❌ secretOrKey: process.env.JWT_SECRET || 'default_secret'
  ✅ const s = config.get<string>('JWT_SECRET');
     if (!s) throw new Error('JWT_SECRET manquant');
  ```

- Chaque JWT DOIT porter un champ `type`
  (`access`, `refresh`, `login-verify`, `identifier-change`, `account-deletion`,
  `event-moderation`). Tout vérificateur DOIT contrôler ce `type` avant d'accepter
  le token.
  ```
  ❌ const p = jwt.verify(t); request.user = p;
  ✅ const p = jwt.verify(t);
     if (p.type !== 'access') throw new UnauthorizedException('Token invalide.');
     request.user = p;
  ```

- Un refresh token NE DOIT JAMAIS être accepté par `JwtAuthGuard`. Seul un token
  `type: 'access'` autorise l'accès aux routes protégées.

- Toute route qui déclenche un envoi SMS/email ou une vérification d'OTP DOIT être
  protégée par `@nestjs/throttler` (limite serrée, ex. 3 requêtes/min). Le rate
  limiting réseau est OBLIGATOIRE, en complément du compteur applicatif par OTP.

- Aucun service d'envoi (`SmsService`, `MailService`) NE DOIT être exposé via un
  contrôleur public. Ils sont appelés uniquement par `OtpService` / services internes.
  ```
  ❌ @Post('send') send(@Body() b) { return this.smsService.sendOtp(b.to, b.code); }
  ✅ (aucune route publique ; appel interne uniquement)
  ```

- Les réponses d'authentification (login, changement/suppression d'identifiant)
  NE DOIVENT PAS révéler l'existence d'un compte. Message ET comportement identiques
  que le compte existe ou non.
  ```
  ❌ if (!user) throw new UnauthorizedException(); else await sendOtp(...);
  ✅ if (user && user.verified && user.isValid) await sendOtp(...);
     return { message: 'Si un compte existe, un code a été envoyé.' };
  ```

- Toute valeur non fiable rendue en HTML DOIT être échappée.
  ```
  ❌ `<input value="${token}"/>`
  ✅ const esc = (s='') => s.replace(/[&<>"']/g, c =>
       ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
     `<input value="${esc(token)}"/>`
  ```

- Le hachage bcrypt DOIT utiliser une constante partagée (12 tours minimum) partout.
  ```
  ❌ bcrypt.hash(pw, 10)  …ailleurs…  bcrypt.hash(pw, 12)
  ✅ const BCRYPT_ROUNDS = 12; bcrypt.hash(pw, BCRYPT_ROUNDS)
  ```

- Les codes OTP DOIVENT être hachés en base, jamais stockés en clair. Ne pas
  imposer d'unicité globale sur le code (anti-pattern qui réduit l'entropie) :
  générer un code aléatoire cryptographique.

- `main.ts` DOIT activer `helmet()`. Si CORS est activé, il DOIT utiliser une liste
  blanche d'origines explicites — JAMAIS `origin: true` / `*` avec `credentials`.

- Le rôle par défaut d'un nouveau compte NE DOIT PAS être `ADMIN`.

## 2. Base de données / Prisma

- Toute suite lecture→écriture qui doit rester cohérente DOIT être encapsulée dans
  un `$transaction`. Ne jamais présumer qu'un check-then-act est atomique.

- Toute colonne utilisée dans un `where` de `findFirst`/`findMany` fréquent DOIT
  avoir un `@@index` (ex. `OtpVerification.identifier`).

- Les erreurs Prisma connues DOIVENT être mappées vers des codes HTTP corrects via
  un `ExceptionFilter` global (`P2002` → 409, `P2025` → 404…). Jamais de 500 brut
  sur un conflit d'unicité.

- Le nommage DOIT être cohérent : camelCase pour les champs (`userId`, pas `UserId`)
  et pas de typo dans les relations (`otpVerifications`, pas `otpVerications`).

- Un `@default` de champ statut DOIT refléter l'état réel à la création (ne pas
  laisser `DRAFT` si le code écrit toujours `PENDING_REVIEW`).

## 3. Architecture NestJS

- L'ordre des routes DOIT placer les chemins statiques AVANT les chemins paramétrés.
  ```
  ❌ @Get(':id')  puis  @Get('moderate')   // /events/moderate capturé par :id
  ✅ @Get('moderate')  puis  @Get(':id')
  ```

- Aucune route stub générée (`findAll`/`findOne`/`remove` non implémentés) NE DOIT
  rester exposée. La supprimer.

- L'extraction du user authentifié DOIT être uniforme : toujours `req.user.sub`
  (ne jamais mélanger `.id` et `.sub`). Préférer un décorateur `@CurrentUser()`.
  ```
  ❌ update → req.user.sub  ;  changePassword → req.user.id
  ✅ partout req.user.sub
  ```

- Les DTO d'entrée DOIVENT utiliser class-validator et rester cohérents avec les
  enums Prisma. Pas de DTO mort ni invalide.
  ```
  ❌ @IsEnum(['ORGANIZER, AGENT'])  // une seule chaîne avec virgule
  ✅ @IsEnum($Enums.Role)
  ```

- Le typage des objets `data` Prisma DOIT être explicite (`Prisma.XCreateInput`),
  jamais `any`.

- La logique métier (lecture/parsing de headers, règles) NE DOIT PAS vivre dans un
  service via `@Req()`/`@Body()`. Le contrôleur extrait, le service reçoit des
  valeurs typées.

## 4. Gestion d'erreurs

- Un effet de bord non critique (email de notification) NE DOIT PAS faire échouer la
  requête principale : `try/catch` + log, sans propager de 500.

- Les messages d'erreur NE DOIVENT PAS divulguer d'info interne (stack, existence de
  compte, détails Prisma).

- Toute vérification de JWT (`jwt.verify`) DOIT être enveloppée dans un `try/catch`
  renvoyant une exception HTTP propre (401), pas une 500.

## 5. Conventions

- La configuration DOIT être lue via `ConfigService`, pas `process.env` directement
  dans les services (cohérence).
- Pas de code mort (`this;`, méthodes générées inutilisées, DTO non branchés).
- Commentaires et messages d'erreur en français (conforme au projet).
- Ne pas ajouter « Co-Authored-By » dans les messages de commit git.
