# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Vybe is a NestJS backend (TypeScript) for an event-ticketing platform: user auth (email/phone OTP), profile management, events (creation + moderation), ticketing/orders, and security agents who scan QR tickets. Code comments and error messages are written in French.

## Commands

```bash
npm run start:dev       # run with watch mode
npm run build           # nest build
npm run lint            # eslint --fix on src/apps/libs/test
npm run format          # prettier --write on src/test

npm run test            # unit tests (jest, rootDir: src, matches *.spec.ts)
npm run test:watch
npm run test:cov
npm run test:e2e        # e2e tests, uses test/jest-e2e.json

# run a single test file
npx jest src/auth/auth.service.spec.ts
# run a single test by name
npx jest src/auth/auth.service.spec.ts -t "test name"
```

### Prisma

```bash
npx prisma migrate dev --name <name>   # create/apply a migration
npx prisma generate                     # regenerate the Prisma client
```

The Prisma client is generated to `node_modules/@prisma/client` — datasource is Postgres via `DATABASE_URL`. Enums are imported via `import { $Enums } from '@prisma/client'`.

## Architecture

### Module layout
Standard NestJS feature modules under `src/`: `auth`, `users`, `otp`, `sms`, `mail`, `prisma`, `events`. Each follows the Nest CLI generator shape (module/controller/service/dto/entities), though some generated files (`create-*.dto.ts`, `update-auth.dto.ts`, etc.) have been removed where the corresponding CRUD endpoints aren't used — don't recreate them.

- `PrismaModule` / `PrismaService` — global-ish Prisma client wrapper (connects/disconnects on module lifecycle). Injected wherever DB access is needed.
- `OtpModule` (`src/otp`) — central OTP generation/verification logic, used by both `auth` and `users`. Depends on `SmsModule` and `MailModule` for delivery.
- `SmsModule`/`SmsService` — Twilio wrapper for sending SMS OTPs (`TWILIO_*` env vars).
- `MailModule`/`MailService` — SendGrid wrapper for sending email OTPs (`SENDGRID_*` env vars). Also handles event moderation/decision emails (`sendEventModerationEmail`, `sendEventDecisionEmail`).
- `AuthModule` — registration/login flows, JWT issuance, `JwtStrategy` (passport-jwt) and `JwtAuthGuard`. Exports `JwtModule` and `JwtAuthGuard` for reuse by other modules.
- `UsersModule` — authenticated profile operations (update profile, change password, change email/phone).
- `EventsModule` (`src/events`) — event creation with moderation workflow. Two services: `EventsService` (validation + transactional creation) and `EventModerationService` (magic-link tokens + approve/reject). See "Event creation and moderation flow" below.

### Auth/registration flow (multi-step, token-chained)
Registration is OTP-first and uses short-lived JWTs as state carriers between steps (no server-side session):

1. `POST /auth/email/send` or `/auth/phone/send` — `OtpService` generates+persists a 6-digit OTP (`OtpVerification` table) and sends it via `MailService`/`SmsService`. Returns a 15-min `tempToken` (JWT) with `purpose: 'verify'` and a `jti`, carrying the email/phone.
2. `POST /auth/email/verify` or `/auth/phone/verify` — verifies the OTP against the `OtpVerification` record (max attempts, expiry, marks `used`), then issues a new 15-min `tempToken` with `purpose: 'complete-profile'`, `verified: true`.
3. `POST /auth/complete-profile` — verifies that token, checks the `jti` hasn't been consumed before (`UsedToken` table prevents replay), creates the `User` + records the `jti` in a single `$transaction`, returns the real session JWT (`signToken`, 1h expiry, `{ sub, role }`).

Login (`/auth/login/email`, `/auth/login/phone`) compares bcrypt hashes against a constant-time dummy hash to avoid timing/user-enumeration leaks when the account doesn't exist.

`OtpService.sendEmailOtp`/`sendPhoneOtp` deliberately send a generic "someone tried to register with your identifier" message (without revealing account existence) when the identifier is already registered, instead of issuing a real OTP.

### Authenticated routes and authorization
`JwtAuthGuard` (in `src/auth/guards/`) manually verifies the bearer token via `JwtService` and attaches `{ sub, role }` to `request.user` — apply with `@UseGuards(JwtAuthGuard)`. `UsersController`'s `me`/`me/password`/`me/identifier` routes use `req.user.id` or `req.user.sub`.

`RolesGuard` (`src/auth/guards/roles.guard.ts`) + `@Roles(...)` decorator (`src/auth/decorators/roles.decorator.ts`) — checks `request.user.role` against required roles. The `Role` enum has two values: `USER` (tout inscrit : crée événements/agents, achète/offre des billets) and `AGENT` (agent de sécurité : scan des QR uniquement). Registration creates users with role `USER`; agent tokens carry role `AGENT`. Used e.g. on `POST /events` (`@Roles('USER')`) and `POST /agents/scan` (`@Roles('AGENT')`). Apply with `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(...)`.

### Profile update limits
`UsersService.update` enforces a max of 2 profile edits per calendar month, tracked via `profileUpdateCount`/`profileUpdateMonth`/`profileUpdateYear` on `User`. Usernames are checked against a reserved-word list loaded from `src/text/banned_usernames.txt` (path differs between dev `src/...` and prod `dist/...`, copied as an asset per `nest-cli.json`).

### Identifier change flow
`requestIdentifierChange` issues a 10-min JWT temp token encoding `{ sub: userId, newIdentifier, type: 'identifier-change' }` and sends an OTP to the new identifier; `verifyIdentifierChange` (header `x-temp-token`) validates the token + OTP, then updates `email` or `phone` on the user.

### Account deletion flow (soft delete, OTP-confirmed)
Two authenticated steps (`JwtAuthGuard`), modeled on the identifier-change flow:
1. `DELETE /users/me` — `requestAccountDeletion` sends an account-deletion OTP to the user's own identifier (email if set, else phone) via `OtpService.sendAccountDeletion{Email,Phone}Otp` (real OTP with the same block/cooldown protections as login), and returns a 10-min JWT temp token `{ sub: userId, type: 'account-deletion' }`.
2. `POST /users/me/delete/verify` (header `x-temp-token` + `{ otp }`) — `verifyAccountDeletion` validates the token (type + `sub` match), verifies the OTP, then **soft-deletes**: sets `User.isValid = false` and `User.deletionRequestedAt = now`. No hard delete — the row is retained for a 2-week grace period for recovery.

Soft-deleted accounts (`isValid = false`) are rejected at login (`loginEmail`/`loginPhone` and the OTP-verify steps in `auth.service`). The OTP message (email HTML reuses `MailService`'s design via `sendAccountDeletionOtp`; SMS reuses the same text) warns the user the account stays stored for two weeks. Automatic purge after 14 days and a recovery endpoint are not yet implemented.

### Event creation and moderation flow
Full event creation in a single `POST /events` (authenticated, `USER` only). The request includes event data + media (with exactly one poster `isPoster: true`) + 1–4 ticket categories (named freely, unlimited stock, each with a design URL). The client uploads files elsewhere and provides URLs — no upload pipeline in the backend.

**Workflow:**
1. `POST /events` — `EventsService.createEvent` validates business rules (dates in future, end > start, purchaseDeadline ≤ start, termsAccepted = true, exactly 1 poster, 1–4 ticket categories), creates `Event` (status `PENDING_REVIEW`) + `EventMedia[]` + `TicketCategory[]` in a single Prisma `create` with nested writes, then sends a moderation email to `VYBE_TEAM_EMAIL` with all event details, poster image, ticket categories, and magic links (Approve/Reject).
2. `GET /events/moderate?token=&decision=` (public) — returns an HTML confirmation page with a button that POSTs (prevents accidental validation by email client link prefetching).
3. `POST /events/moderate` (public, body `{ token, decision }`) — `EventModerationService.moderate` verifies the JWT token (`type: 'event-moderation'`, 7-day expiry), checks anti-replay via `UsedToken.jti`, validates the event is still `PENDING_REVIEW`, then in a `$transaction`: updates status to `PUBLISHED` or `REJECTED` + creates `UsedToken`. Notifies the creator by email if they have one.
4. `GET /events/:id` (public) — returns the full event with media, ticket categories, and creator info.

### Config
`ConfigModule` is global. Key env vars: `DATABASE_URL`, `JWT_SECRET`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_PHONE_NUMBER`, `SENDGRID_API_KEY`/`SENDGRID_FROM_EMAIL`/`SENDGRID_FROM_NAME`, `PORT`, `VYBE_TEAM_EMAIL` (moderation email recipient, fallback `SENDGRID_FROM_EMAIL`), `API_BASE_URL` (base URL for magic links, e.g. `http://localhost:3000`).

## Testing notes
Jest config in `package.json` includes `moduleNameMapper: { "^src/(.*)$": "<rootDir>/$1" }` to resolve the codebase's `src/...` absolute imports. The full suite is green (16 suites / 67 tests). The previously-broken auto-generated `should be defined` smoke specs (`auth.controller.spec`, `users.controller.spec`, `users.service.spec`, `sms.service.spec`, `mail.controller.spec`) have been fixed by supplying the injected dependencies: controller specs mock their service (`{ provide: Service, useValue: {} }`), and `UsersController` neutralizes `JwtAuthGuard` via `.overrideGuard(...)`; service specs instantiate the real service with mocked deps — note `SmsService`'s `ConfigService.get` mock must return an `AC`-prefixed value because its constructor runs `new Twilio(...)`.

## Linting notes
`@typescript-eslint/no-explicit-any` is off, `no-floating-promises` and `no-unsafe-argument` are warnings (not errors) per `eslint.config.mjs`.

## TODO avant mise en production

- **Scan antivirus des PDF uploadés** — `POST /uploads` (`UploadsService`) accepte `application/pdf` (`ALLOWED_MIME` dans `src/common/constants.ts`) mais NE scanne PAS encore les PDF infectés/piégés. À implémenter avant la prod. Options évaluées : ClamAV/`clamscan` (vrai AV, nécessite un démon `clamd` — pas fourni par Render/Neon par défaut) ; scan heuristique sans infra (détecter `/JavaScript`, `/JS`, `/Launch`, `/OpenAction`, `/EmbeddedFile` dans le buffer) ; API externe (VirusTotal, expose le fichier à un tiers). Décision reportée. **Rappeler ce point à l'utilisateur au moment de préparer la prod.**

## Instructions

- Ne pas ajouter "Co-Authored-By" dans les messages de commit git.
- Toutes les analyses juridiques doivent couvrir les **deux** marchés visés par Vybe, en indiquant lequel s'applique selon le public de l'événement / de l'acheteur :
  - **RDC** (public congolais) : droit commercial OHADA, droit de la consommation congolais, Code du numérique (loi n°23/010 du 13 mars 2023 — commerce électronique, protection des données, cybersécurité), fiscalité RDC (TVA 16 %, RCCM / Id. Nat. / NIF).
  - **France / Union européenne** (public FR-UE) : droit commercial français (Code de commerce), droit de la consommation (ventes de produits en ligne), RGPD, et règlements européens récents (AI Act, DSA).