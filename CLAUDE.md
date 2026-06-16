# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Vybe is a NestJS backend (TypeScript) for an event-ticketing platform: user auth (email/phone OTP), profile management, events, ticketing/orders, and security agents who scan QR tickets. The schema (`prisma/schema.prisma`) is far ahead of the implemented modules — only auth, users, otp, sms, and mail are currently built out. Code comments and error messages are written in French.

## Commands

```bash
npm run start:dev       # run with watch mode
npm run build            # nest build
npm run lint             # eslint --fix on src/apps/libs/test
npm run format            # prettier --write on src/test

npm run test              # unit tests (jest, rootDir: src, matches *.spec.ts)
npm run test:watch
npm run test:cov
npm run test:e2e          # e2e tests, uses test/jest-e2e.json

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

The Prisma client is generated to `generated/` (see `generated/` dir) — datasource is Postgres via `DATABASE_URL`.

## Architecture

### Module layout
Standard NestJS feature modules under `src/`: `auth`, `users`, `otp`, `sms`, `mail`, `prisma`. Each follows the Nest CLI generator shape (module/controller/service/dto/entities), though some generated files (`create-*.dto.ts`, `update-auth.dto.ts`, etc.) have been removed where the corresponding CRUD endpoints aren't used — don't recreate them.

- `PrismaModule` / `PrismaService` — global-ish Prisma client wrapper (connects/disconnects on module lifecycle). Injected wherever DB access is needed.
- `OtpModule` (`src/otp`) — central OTP generation/verification logic, used by both `auth` and `users`. Depends on `SmsModule` and `MailModule` for delivery.
- `SmsModule`/`SmsService` — Twilio wrapper for sending SMS OTPs (`TWILIO_*` env vars).
- `MailModule`/`MailService` — SendGrid wrapper for sending email OTPs (`SENDGRID_*` env vars).
- `AuthModule` — registration/login flows, JWT issuance, `JwtStrategy` (passport-jwt) and `JwtAuthGuard`.
- `UsersModule` — authenticated profile operations (update profile, change password, change email/phone).

### Auth/registration flow (multi-step, token-chained)
Registration is OTP-first and uses short-lived JWTs as state carriers between steps (no server-side session):

1. `POST /auth/email/send` or `/auth/phone/send` — `OtpService` generates+persists a 6-digit OTP (`OtpVerification` table) and sends it via `MailService`/`SmsService`. Returns a 15-min `tempToken` (JWT) with `purpose: 'verify'` and a `jti`, carrying the email/phone.
2. `POST /auth/email/verify` or `/auth/phone/verify` — verifies the OTP against the `OtpVerification` record (max attempts, expiry, marks `used`), then issues a new 15-min `tempToken` with `purpose: 'complete-profile'`, `verified: true`.
3. `POST /auth/complete-profile` — verifies that token, checks the `jti` hasn't been consumed before (`UsedToken` table prevents replay), creates the `User` + records the `jti` in a single `$transaction`, returns the real session JWT (`signToken`, 1h expiry, `{ sub, role }`).

Login (`/auth/login/email`, `/auth/login/phone`) compares bcrypt hashes against a constant-time dummy hash to avoid timing/user-enumeration leaks when the account doesn't exist.

`OtpService.sendEmailOtp`/`sendPhoneOtp` deliberately send a generic "someone tried to register with your identifier" message (without revealing account existence) when the identifier is already registered, instead of issuing a real OTP.

### Authenticated routes
`JwtAuthGuard` (in `src/auth/guards/`) manually verifies the bearer token via `JwtService` and attaches `{ id, role }` to `request.user` — apply with `@UseGuards(JwtAuthGuard)`. `UsersController`'s `me`/`me/password`/`me/identifier` routes use `req.user.id`.

### Profile update limits
`UsersService.update` enforces a max of 2 profile edits per calendar month, tracked via `profileUpdateCount`/`profileUpdateMonth`/`profileUpdateYear` on `User`. Usernames are checked against a reserved-word list loaded from `src/text/banned_usernames.txt` (path differs between dev `src/...` and prod `dist/...`, copied as an asset per `nest-cli.json`).

### Identifier change flow
`requestIdentifierChange` issues a 10-min JWT temp token encoding `{ sub: userId, newIdentifier, type: 'identifier-change' }` and sends an OTP to the new identifier; `verifyIdentifierChange` (header `x-temp-token`) validates the token + OTP, then updates `email` or `phone` on the user.

### Config
`ConfigModule` is global. Key env vars: `DATABASE_URL`, `JWT_SECRET`, `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_PHONE_NUMBER`, `SENDGRID_API_KEY`/`SENDGRID_FROM_EMAIL`/`SENDGRID_FROM_NAME`, `PORT`.

## Linting notes
`@typescript-eslint/no-explicit-any` is off, `no-floating-promises` and `no-unsafe-argument` are warnings (not errors) per `eslint.config.mjs`.
