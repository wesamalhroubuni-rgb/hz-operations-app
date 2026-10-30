# apps/api memory

Package `@ops/api`. Last updated: 2026-10-28 (Phase 6).

## Purpose

The REST API. It owns the PostgreSQL database, the business rules, sign-in and sessions, the
permission rules, photo storage, notifications, the audit trail, and the event outbox. Both clients
(web and mobile) talk only to this API (and to object storage through URLs it signs).

## Phase 6 additions (2026-10-28, ADR-0009)

Code complete, tested, and reviewed; about to be committed. Migration
`20261028090000_phase6_dashboard` adds `User.locale` (default `en`); the user full profile maps
`locale`, the organization summary maps `timeZone` (`settings.timeZone`, default
`Europe/Istanbul`). 11 new paths:

- New modules `operations/dashboard/` (`GET /dashboard/overview`, `GET /directory`),
  `operations/exports/` (`GET /exports/work-logs.csv`, `/exports/tasks.csv`),
  `operations/reports/` (`GET /reports/work-logs`), `operations/history/` (record histories
  served by `GET /work-logs/:id/history` and `GET /tasks/:id/history`).
- Shared query builders: `work-logs/work-log-query.ts` (`workLogWhere`, `ATTACHMENT_COUNT`,
  `excerptOf`; filters `search`, `hasPhotos`, `excludeOwn`) and `tasks/task-query.ts`
  (`taskWhere`, `open`, `overdue`): the list, map, export, report and overview all count with the
  same `where`. The overview's "awaiting approval" uses `status=submitted&excludeOwn=true`.
- Exports: CSV through `toCsv` from `@ops/shared` (formula injection neutralised), UTF-8 BOM, at
  most 10,000 rows (422 `export_too_large`), audited (`export.work_logs` / `export.tasks`).
- Log types: a changed field key is **not** refused (a rename cannot be told apart from remove
  plus add); the web editor locks saved keys (decision of 2026-10-28).
- `common/names.ts` (id to name maps through each visibility filter), `common/org-time-zone.ts`.
- `ChangeRecorder.recordAccess`: the audit-only path for exports (no outbox event).
- `POST /work-logs/bulk-status` loops `changeStatus` per item (own transaction, audit, outbox).
- `AuthAdminService.listUserSessions`; `GET /users/:id/sessions`, `POST /users/:id/sessions/revoke`.
- `locale` on user create/update (self may change own `displayName` and `locale`), in the
  audit record and in `/auth/me`; notifications rendered per recipient locale (en; tr, ar fall
  back to English per key).
- Six policies: `dashboard.read`, `directory.read`, `work_log.review`, `export.work_logs`,
  `export.tasks`, `report.read` (supervisor, manager, admin). No new index or migration: the
  existing `(organizationId, occurredAt|status|authorId|siteId|teamId)` and audit
  `(organizationId, entityType, entityId)` indexes cover the new queries.
- Tests: `src/operations/dashboard/phase6.spec.ts` (unit), `test/dashboard.int-spec.ts`,
  `test/dashboard-scope.int-spec.ts`, and new rows in `test/permissions-matrix.int-spec.ts`
  (integration).

## Current state

Phase 5 committed (`2cf5a01`); Phase 6 as above.

- **68 paths**: the Phase 2 resources, nine `/auth/*` routes, the two user code routes, from
  Phase 4 `POST /attachments/:id/complete`, `POST /attachments/:id/upload-url`, and five
  `/notifications` paths, from Phase 5 `GET /sync/pull`, and the 11 Phase 6 paths. The full list with the policy of each
  route, the HTTP conventions, and the permissions matrix are in
  [ARCHITECTURE.md](../../ARCHITECTURE.md).
- **Offline sync** (ADR-0008): `Task.version` and `WorkLog.version` raised by every change;
  `expectedVersion` on log edits and status changes and task status changes (409
  `version_conflict` unless the request is a no-op); typed refusal codes (`already_reviewed`,
  `edit_window_closed`, `record_archived`, `task_not_assigned`, `task_cancelled`,
  `occurred_at_out_of_range`, `attachment_not_declared`, ...); `Idempotency-Key` on the four
  `@Idempotent()` writes (`src/platform/idempotency/`); offline creates store
  `submittedOffline`, `deviceCreatedAt`, `clockSkewSeconds`, and the declared photo client ids,
  drop unusable references instead of refusing, and respect `offlineMaxBackdateDays`; declared
  photos accepted for 30 days; audit `metadata` `via: offline_sync`; `GET /sync/pull`
  (`src/operations/sync/`).
- **File storage** (`src/platform/storage/`, ADR-0006): `S3FileStorage` on any S3-compatible store
  (MinIO in development), an internal client on `STORAGE_ENDPOINT` and a signer on
  `STORAGE_PUBLIC_ENDPOINT`. Uploads are direct pre-signed PUTs (type and size signed) to an
  API-chosen key; `complete` verifies by content, re-encodes to an API-only `.verified.` key, and
  makes a 320 px thumbnail. Signed download URLs only for ready attachments the caller can see.
  Hourly cleanup of abandoned uploads and purge of their bytes.
- **Notifications** (`src/platform/notifications/`, `src/operations/notifications/`, ADR-0007):
  in-app list (source of truth), `NotificationChannel` interface, Expo push channel with generic
  text, push tokens bound to sessions; the outbox consumer (`src/platform/outbox/`) turns
  `task.created`, `task.assignees_changed`, and `work_log.status_changed` into notifications.
- **Status changes** carry a reason: `PATCH /tasks/:id/status { status, reason? }` (required for
  `blocked`, stored as `statusReason`); `PATCH /work-logs/:id/status { status, note? }` (required
  for `rejected`, stored as the `review`).
- **Sign-in** (`src/platform/auth/`, ADR-0004): email, phone, or username plus password; JWT access
  tokens (15 minutes) and rotating refresh tokens with reuse detection; httpOnly cookies and CSRF
  for `web`, bearer tokens for `mobile`; argon2id; one-time activation and reset codes; rate limits
  and lockout; security audit events. Every request checks the session and the user in the
  database.
- **Authorization** (`src/operations/access/`, ADR-0005): one global guard applies the route's
  policy from the registry; services apply pure object-level rules and visibility filters from one
  definition per resource; role-shaped responses (users `basic` / `contact` / `full`,
  organization `summary` / `full`).
- **Data model**: 14 business models, four auth tables, three notification platform tables
  (`Notification`, `PushToken`, `OutboxConsumerCursor`), `IdempotencyRecord`, six migrations,
  UUIDv7 ids.
- **Every write** is one transaction: business row, audit event, outbox event, through
  `ChangeRecorder`. Auth security events and push token changes go to the audit log only;
  notification rows are not audited.
- **Swagger** at `/docs`, `/docs-json`, `/docs-yaml`, in development only, with a bearer scheme.
- **Tests**: 527 unit tests in 25 suites; 1,534 integration tests in 21 suites.

Verified in the Phase 6 session (2026-10-28): unit tests re-run by the docs-keeper; integration
tests, lint, typecheck, and build as reported by the coordinator. **Not applied**: the Phase 5 and
Phase 6 migrations on the development database, which holds a stray
`20261018090000_phase5_offline_sync` from lost work; the owner must run `pnpm db:reset`. Earlier
(Phase 4): storage against the real MinIO, a live in-app notification, push token removal on
sign-out. **Not verified**: real Expo push delivery, any provider other than MinIO.

## Layout

```text
src/
  main.ts                 boot: env, x-powered-by off, trust proxy (TRUST_PROXY_HOPS), request
                          context, CORS with credentials, Swagger (dev), listen
  app.module.ts           AppConfig, Prisma, Platform, Health, Operations
  route-policies.spec.ts  every route has @Public/@Authenticated/a registered @Policy
  config/                 env.ts (Zod schema, validateEnv, production refusals), app-config.module.ts
  prisma/                 PrismaService (lazy connection, adapter-pg), PrismaModule
  health/                 GET /health (@Public)
  platform/               REUSABLE. Must not import src/operations (ESLint error)
    platform.module.ts    global: middleware, no-store on /auth, exception filter, AuthGuard,
                          IdempotencyInterceptor,
                          auth/audit/outbox controllers, auth providers; imports StorageModule
                          and NotificationsModule
    storage/              file-storage.ts (interface, FILE_STORAGE, safe Content-Disposition),
                          s3-file-storage.ts, images.ts (verify, re-encode, thumbnail,
                          ImageProcessor), concurrency.ts (ConcurrencyLimit, KeyedSerializer),
                          storage-settings.ts, storage.module.ts
    request-context/      RequestContext (AsyncLocalStorage: correlation id, actor, offline-sync
                          facts), middleware
    idempotency/          @Idempotent(), IdempotencyInterceptor (global), IdempotencyService
                          (claim, replay, release, hourly expiry), request hash
    http/                 ApiException (incl. rateLimited), filter, ZodPipe, ApiDocs, pagination,
                          filters, requireActor, @Public()
    auth/                 auth.guard.ts, auth.controller.ts, auth.service.ts, auth-admin.service.ts,
                          sessions.ts, access-token.ts, csrf.ts, auth-http.ts (cookies, Origin),
                          one-time-codes.ts, password-hasher.ts, password-policy.ts,
                          identifiers.ts, rate-limiter.ts, auth-settings.ts, auth-db.ts,
                          auth-profile.ts, hashing.ts, clock.ts
    authz/                @Policy, @Authenticated, @DevelopmentOnly, REQUEST_AUTHORIZER
    notifications/        notification-channel.ts, notification.service.ts,
                          notification-inbox.service.ts, notifications.controller.ts,
                          push-tokens.service.ts, expo-push-client.ts, expo-push.channel.ts,
                          notifications.module.ts; notification-sender.ts (Phase 3 codes)
    audit/                AuditService (writer), audit-snapshot (diff, redaction), query, controller
    outbox/               OutboxService, query, controller (@DevelopmentOnly), outbox-consumer.ts,
                          outbox-consumer-state.ts (pure bookkeeping)
    docs/                 Swagger setup (bearer and cookie schemes)
  operations/             the Operations domain
    operations.module.ts
    access/               policies.ts (registry), access.service.ts, access-context.ts,
                          decision.ts, visibility.ts, rules/*.rules.ts,
                          operations-request-authorizer.ts, operations-auth-profile.provider.ts,
                          access.module.ts (global), clock.ts, testing.ts
    common/               ChangeRecorder (record, recordAccess), references.ts, concurrency.ts
                          (NEXT_VERSION, assertExpectedVersion), names.ts, org-time-zone.ts,
                          hierarchy.ts, db.ts
    sync/                 GET /sync/pull: sync.service.ts, sync.controller.ts, sync-cursor.ts
    dashboard/            GET /dashboard/overview, GET /directory (Phase 6)
    exports/              GET /exports/work-logs.csv, /exports/tasks.csv (audited)
    reports/              GET /reports/work-logs
    history/              record histories for GET /work-logs/:id/history, /tasks/:id/history
    organization/ users/ memberships/ sites/ teams/ log-types/ tasks/ work-logs/ attachments/
                          each: *.controller.ts, *.service.ts, *.module.ts
    memberships/admin-guard.ts   last-admin check under an advisory lock
    attachments/          attachments.service.ts (upload flow, signed URLs, rate limits),
                          attachment-cleanup.service.ts (hourly expiry and purge)
    notifications/        notification-rules.ts (pure), notification-messages.ts (catalogue per
                          locale, English complete, generic push text),
                          operations-notifications.service.ts (registers the outbox handlers,
                          renders per recipient locale), module
    scope/                resolve-scope.ts (pure), scope.service.ts, scope.controller.ts
    seed/                 demo-seed.ts (DEV_PASSWORDS)
  generated/              Prisma client. Git-ignored. Never edit
prisma/
  schema.prisma
  migrations/             20261013112952_init, 20261013150000_attachment_storage_key_per_org,
                          20261014090000_auth, 20261017090000_phase4_mobile,
                          20261027090000_phase5_offline_sync, 20261028090000_phase6_dashboard
  seed.ts                 entry point of the seed
test/
  *.int-spec.ts           integration suites
  support/                test-database.ts (safety guard), test-app.ts (harness, sessions, fake
                          clock, notification sender, file storage, and Expo client),
                          fake-file-storage.ts, test-images.ts, factories.ts, matrix-world.ts
  run-integration.mjs     starts Jest without NODE_PATH
```

## Key files

| File                                                       | What it does                                                                                                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config/env.ts`                                        | Environment schema. Production refuses placeholder or repetitive auth and storage secrets and a non-https `WEB_APP_URL` or `STORAGE_PUBLIC_ENDPOINT`.                                         |
| `src/platform/storage/s3-file-storage.ts`                  | `FileStorage` on S3: internal and signer clients, bucket check or creation at start-up, signed PUT (type and length) and GET, stat, ranged read, put.                                         |
| `src/platform/storage/images.ts`                           | `verifyImage` (magic bytes, full decode, 24 MP cap, re-encode, 320 px thumbnail) and `ImageProcessor` (2 decodes at once, 30 s wait).                                                         |
| `src/operations/attachments/attachments.service.ts`        | `startUpload`, `renewUpload`, `complete`, `archive`, `present` (signed URLs); key helpers `attachmentStorageKey`, `verifiedKeyOf`, `thumbnailKeyOf`.                                          |
| `src/operations/attachments/attachment-cleanup.service.ts` | Hourly: expire pending uploads older than 24 h (claim, then delete), purge bytes of archived pending uploads (48 h window).                                                                   |
| `src/platform/notifications/notification.service.ts`       | `notify` (write rows, deliver after commit), `notifyInTransaction`, `deliver`, `whenIdle`. Idempotent per `(sourceEventId, recipientId, type)`.                                               |
| `src/platform/notifications/push-tokens.service.ts`        | Register (bound to the session, one per session, rebinding), unregister, `sessionsEnded`, `deliverableTokens`, `removeInvalid`; audited.                                                      |
| `src/platform/notifications/expo-push.channel.ts`          | Sends one push per live token with the generic text; tickets and in-memory receipts; removes `DeviceNotRegistered` tokens.                                                                    |
| `src/platform/outbox/outbox-consumer.ts`                   | Named consumer, `registerHandler`, polling, `processPending()`, cursor table; the rules are in `outbox-consumer-state.ts` (60 s settle, retries).                                             |
| `src/operations/notifications/notification-rules.ts`       | Which event notifies whom (pure); the service re-checks the current state before writing.                                                                                                     |
| `src/platform/auth/auth.guard.ts`                          | The one global guard: development-only 404, public, authenticate (bearer or cookie, database check), CSRF, actor, policy. Order in its header comment.                                        |
| `src/platform/auth/auth.service.ts`                        | Login (slug rule, lockout, generic failure), refresh, logout, sessions, set-password, change-password, the security audit events.                                                             |
| `src/platform/auth/sessions.ts`                            | Session creation, refresh rotation with the race and reuse rule, revocation, and the `onSessionsEnded` hook (push tokens go with the session).                                                |
| `src/platform/auth/auth-admin.service.ts`                  | The contract for business modules: `issueOneTimeCode`, `revokeUserSessions`, `listUserSessions`, `setPasswordForSeed`, `isActivated`, `activatedUserIds`.                                     |
| `src/platform/auth/auth-settings.ts`                       | Every auth setting and the default rate limits.                                                                                                                                               |
| `src/platform/authz/policy.decorator.ts`                   | `@Policy`, `@Authenticated`, `@DevelopmentOnly`.                                                                                                                                              |
| `src/platform/http/api-exception.filter.ts`                | Standard error body; maps Prisma `P2002` to 409, `P2003` to 422, `P2025` to 404; sets `Retry-After`.                                                                                          |
| `src/platform/audit/audit.service.ts`                      | `record(tx, input)`: one audit row with redacted `before`, `after`, and `changes`.                                                                                                            |
| `src/operations/access/policies.ts`                        | The policy registry: name, roles, description. `listPolicies()`. The permissions matrix is written from it.                                                                                   |
| `src/operations/access/access.service.ts`                  | `context()` (per-request cached access context) and `runAsSystem()`.                                                                                                                          |
| `src/operations/access/visibility.ts`                      | `Visibility` values, `isVisible()`, `visibilityWhere()`.                                                                                                                                      |
| `src/operations/access/rules/`                             | Pure rules per resource returning a `Decision`; `decision.ts` `enforce()` turns it into 404, 403, or 409.                                                                                     |
| `src/operations/common/change-recorder.ts`                 | `record(tx, change)`: the audit event and the outbox event of one change (`auditMetadata` for dropped references); `recordAccess`: audit only (exports).                                      |
| `src/operations/common/concurrency.ts`                     | `NEXT_VERSION` and `assertExpectedVersion` (409 `version_conflict`). ADR-0008 section 1.                                                                                                      |
| `src/platform/idempotency/idempotency.service.ts`          | `Idempotency-Key` claim, replay, take-over after the 60 s lock, release of non-final answers, hourly deletion after 14 days. Header comment: why it is safe outside the business transaction. |
| `src/operations/sync/sync.service.ts`                      | `GET /sync/pull`: the caller's slice through the visibility filters, `upserts` since the cursor minus 60 s, complete `ids` per resource.                                                      |
| `src/operations/sync/sync-cursor.ts`                       | The opaque cursor (`v`, time, scope fingerprint); an unusable cursor means a full pull.                                                                                                       |
| `src/operations/common/references.ts`                      | `assertActiveReferences` (exists, same organization, not archived, visible to the caller, else 422) and `assertValidParent`.                                                                  |
| `src/operations/scope/resolve-scope.ts`                    | The scope rules (1 to 8, including `colleagueIds`), as a pure function.                                                                                                                       |
| `src/operations/seed/demo-seed.ts`                         | The demo data, `DEV_PASSWORDS`, and `seedDemo(app)`.                                                                                                                                          |
| `test/support/test-app.ts`                                 | The integration harness: `as(userId)`, `loginAs`, `bearer`, `browser()`, `clock`, `notifications`, `rateLimiter`, the fake storage and Expo client.                                           |
| `prisma.config.ts`                                         | Prisma 7 config. Attaches `DATABASE_URL` only when set.                                                                                                                                       |
| `eslint.config.mjs`                                        | Base config, decorator parser options, and the rule that forbids `src/platform` importing `src/operations`.                                                                                   |
| `nest-cli.json`                                            | `deleteOutDir: true`: every `nest build` wipes `dist/`.                                                                                                                                       |

## Environment variables

Values come from the root `.env`, except `NODE_ENV`, which the scripts set.

| Variable                                                        | Rule                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                      | `development`, `test`, or `production`. Optional; defaults to `production`. Set by scripts.    |
| `DATABASE_URL`                                                  | Required. Must start with `postgres://` or `postgresql://`.                                    |
| `DATABASE_CONNECT_TIMEOUT_MS`                                   | Required. Positive integer, milliseconds.                                                      |
| `API_HOST`                                                      | Required. `127.0.0.1` in `.env.example`. `0.0.0.0` only for a phone test on a trusted network. |
| `API_PORT`                                                      | Required. Integer 1 to 65535.                                                                  |
| `CORS_ORIGINS`                                                  | Required. Comma-separated browser origins; also the CSRF Origin allow-list.                    |
| `LOG_LEVEL`                                                     | Required. One of `verbose`, `debug`, `log`, `warn`, `error`, `fatal`.                          |
| `TRUST_PROXY_HOPS`                                              | Optional, 0 to 10, default 0. Number of reverse proxies to trust for the client address.       |
| `AUTH_ACCESS_TOKEN_SECRET`                                      | Required, at least 32 characters. Production refuses placeholder or repetitive values.         |
| `AUTH_ACCESS_TOKEN_TTL_SECONDS`                                 | Optional, 30 to 86400, default 900.                                                            |
| `AUTH_REFRESH_TOKEN_TTL_DAYS`, `AUTH_SESSION_ABSOLUTE_TTL_DAYS` | Optional, defaults 30 and 90; the absolute value may not be shorter.                           |
| `AUTH_REFRESH_REUSE_GRACE_SECONDS`                              | Optional, 0 to 60, default 10.                                                                 |
| `AUTH_ACTIVATION_CODE_TTL_HOURS`, `AUTH_RESET_CODE_TTL_MINUTES` | Optional, defaults 72 and 60.                                                                  |
| `AUTH_MAX_FAILED_LOGINS`, `AUTH_LOCKOUT_MINUTES`                | Optional, defaults 5 and 15.                                                                   |
| `AUTH_COOKIE_DOMAIN`                                            | Optional domain name; empty means host-only cookies.                                           |
| `WEB_APP_URL`                                                   | Required http(s) URL; `https://` in production. Base of the activation link.                   |
| `STORAGE_ENDPOINT`                                              | Required http(s) URL: where the API reaches the storage.                                       |
| `STORAGE_PUBLIC_ENDPOINT`                                       | Required http(s) URL written into signed URLs; `https://` in production.                       |
| `STORAGE_REGION`, `STORAGE_BUCKET`                              | Required. The bucket name must be a valid S3 name (`hz-attachments`).                          |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`            | Required. Production refuses a placeholder or repetitive secret key.                           |
| `STORAGE_FORCE_PATH_STYLE`                                      | Optional `true`/`false`, default `true`.                                                       |
| `UPLOAD_MAX_BYTES`                                              | Optional, 1024 to 26214400, default 10485760.                                                  |
| `UPLOAD_URL_TTL_SECONDS`, `DOWNLOAD_URL_TTL_SECONDS`            | Optional, 30 to 3600, default 300.                                                             |
| `EXPO_ACCESS_TOKEN`                                             | Optional; sent to Expo only when set.                                                          |
| `PUSH_ENABLED`, `OUTBOX_CONSUMER_ENABLED`                       | Optional `true`/`false`, default `true`. The modules treat anything but `true` as off.         |
| `OUTBOX_POLL_INTERVAL_MS`                                       | Optional, 200 to 60000, default 2000.                                                          |
| `DATABASE_URL_TEST`                                             | Read only by the integration tests. Database name must end in `_test`.                         |

If any is wrong, the process prints one line per variable and exits with code 1, never printing
values. `DEV_AUTH_ENABLED` no longer exists.

## Scripts

Run from the repo root as `pnpm --filter @ops/api <script>`. The root has shortcuts for
`db:migrate`, `db:seed`, `db:reset`, and `test:integration` that build `@ops/shared` first where
needed.

| Script             | Command                                                                                                          |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `dev`              | `prisma generate`, then `nest start --watch` with the root `.env` and `NODE_ENV=development`                     |
| `build`            | `prisma generate`, then `nest build` into `dist/` (deletes `dist/` first)                                        |
| `start`            | `node dist/main.js` with the root `.env` and `NODE_ENV=production`                                               |
| `lint`             | `eslint .`                                                                                                       |
| `typecheck`        | `prisma generate`, then `tsc --noEmit`                                                                           |
| `test`             | `prisma generate`, then Jest through `node --experimental-vm-modules`                                            |
| `test:integration` | `prisma generate`, then `node test/run-integration.mjs` with the root `.env`                                     |
| `db:generate`      | `prisma generate`                                                                                                |
| `db:migrate`       | `prisma migrate dev` with the root `.env`                                                                        |
| `db:deploy`        | `prisma migrate deploy` with the root `.env`                                                                     |
| `db:seed`          | `prisma generate`, compile `src` into `node_modules/.cache/ops-seed`, then `tsx prisma/seed.ts` in `development` |
| `db:reset`         | `prisma migrate reset --force`, then `db:seed`. **Never executed so far. Owner only, never an agent.**           |
| `db:studio`        | `prisma studio` with the root `.env`                                                                             |
| `postinstall`      | `prisma generate`                                                                                                |

## Seed

- `pnpm db:seed` creates the organization "HZ Demo" (slug `hz-demo`) with 2 sites (North Depot,
  Harbour Project), 3 teams (Electrical, Maintenance, Logistics), 10 users with 10 memberships
  (1 admin and 1 manager, organization-wide; 2 supervisors, one scoped to a site and one to a site
  plus a team; 6 workers, one in two teams), 3 log types, 8 tasks, and 25 work logs over 14 days.
- Every user has a username; two workers have a phone number and no email. In `development` and
  `test` every user gets the password of their highest role from `DEV_PASSWORDS` (through
  `AuthAdminService.setPasswordForSeed`, which refuses production). In production no password is
  set and users get activation codes instead. The seed prints names, roles, and identifiers, and
  where the passwords are defined; never a password.
- The structure is created under `AccessService.runAsSystem`; tasks and work logs are created as
  the demo users (creator, author), so they pass the same rules as a request. Work log `createdAt`
  is back-dated with a direct update (seed only) so older logs are outside the edit window and
  today's inside it; some logs are approved or rejected by the manager (rejections with a note),
  and the blocked task has a reason. The seed creates no attachments and no notifications.
- Idempotent on the slug: if the organization exists, nothing is written.
- The seed compiles the API with `tsc` into `node_modules/.cache/ops-seed` (decorator metadata;
  `dist/` belongs to a running dev server).
- The development database holds the Phase 3 seed with the Phase 4 migration applied, plus a
  stray Phase 5 migration from lost work, and lacks the Phase 5 and Phase 6 migrations; it needs
  the owner's `pnpm db:reset` (2026-10-28). The organization's settings get `timeZone`
  `Europe/Istanbul` (and a free `locale: 'en'` key); users keep the default `locale` `en`.

## Tests

- **Unit** (`pnpm --filter @ops/api test`): `src/**/*.spec.ts`, 25 suites, 527 tests (2026-10-28;
  Phase 6 added `operations/dashboard/phase6.spec.ts`).
  No database, no `.env`. Covers the environment schema, health, `ZodPipe`, the platform modules,
  auth (tokens, cookies, CSRF, codes, policy, identifiers, rate limiter), `AuthAdminService`, scope
  resolution, the access rules (including `attachment.rules.spec.ts` and the Phase 5
  `offline-rules.spec.ts`) and visibility, idempotency, the sync cursor, storage
  (`storage.spec.ts`), notifications and Expo push, the outbox consumer, the notification rules,
  and `route-policies.spec.ts`. Running it at the same time as other packages' test runners once
  failed four suites to load on 2026-10-17; a rerun alone passed.
- **Integration** (`pnpm test:integration`): `test/*.int-spec.ts`, 21 suites, 1,534 tests (as
  reported 2026-10-28), a few minutes. Suites: `harness`, `auth-and-errors`, `auth-login`,
  `auth-sessions`, `secrets`, `org-structure`, `log-types`, `tasks`, `work-logs`,
  `audit-outbox-transaction`, `audit-outbox-read`, `tenant-isolation`, `permissions-matrix` (every
  cell, fixture in `support/matrix-world.ts`), `permissions-cases`, and from Phase 4 `uploads`,
  `storage-minio` (the real MinIO, bucket `hz-attachments-test`), `worker-app`, `notifications`,
  from Phase 5 `offline-sync` (versions, codes, idempotency, offline creates, late photos, the
  pull), and from Phase 6 `dashboard` and `dashboard-scope` (every new route per role, changed ids
  and query parameters, bulk review, exports, histories, locales, sessions).
- The harness binds an in-memory `FileStorage` (`support/fake-file-storage.ts`) and a fake Expo
  client; the outbox consumer and push are off, and tests call `processPending()`.
- The harness authenticates for real: `as(userId)` opens a `mobile` session through
  `SessionService` and sends its bearer token; `loginAs` and `browser()` (cookie jar, Origin,
  CSRF) test the sign-in paths. A fake clock drives token, code, lockout, rate-limit, and edit
  windows; a fake notification sender keeps the codes (`notifications.lastCode(userId)`).
  Factories write rows directly with Prisma.
- **The safety guard** is `resolveTestDatabase` in `test/support/test-database.ts`: it refuses to
  run unless `DATABASE_URL_TEST` is set, its database name ends in `_test`, and differs from the one
  in `DATABASE_URL`. Do not weaken it.
- The suites share one database and truncate it between tests, so they run with one worker.
- `run-integration.mjs` exists because the dotenv-cli shim sets `NODE_PATH` to pnpm's hoisted
  store, where the mobile app's Jest 29 packages live.

## Conventions

- Every route declares `@Public()`, `@Authenticated()`, or `@Policy(...)`; a new policy goes into
  `access/policies.ts`, the matrix in ARCHITECTURE.md, and the matrix suite.
- Controllers handle HTTP only: `ZodPipe` on every input, one service call, no role checks.
- Services start with `const context = await this.access.context()`, load records through the
  resource's `xxxVisibilityWhere(context)`, and `enforce(rule(context, facts, ...))` before
  writing. 404 before 403 before 409.
- Every write follows the pattern in `ChangeRecorder`'s comment, inside `prisma.$transaction`.
  Author fields come from `authorOf(context)`. When access is taken away, call
  `AuthAdminService.revokeUserSessions` in the same transaction.
- Body references are checked with `assertActiveReferences`, passing the caller's visibility.
- A no-op write returns the record and records nothing, even with a stale `expectedVersion`.
- Every change of a task or work log raises `version` (`NEXT_VERSION`) in the same transaction;
  edits and status changes lock the row before reading it. Throw typed codes with
  `ApiException.of(code, message, details?)`; a new code goes into `API_ERROR_CODES` and
  `API_ERROR_STATUS` in `@ops/shared` and gets a phone message in `apps/mobile/src/i18n/en.ts`.
- A write the phone queues must be `@Idempotent()` and safe to repeat (ADR-0008 section 4).
- New entity types go into `EntityType` and `PAYLOAD_KEYS` in `change-recorder.ts`, and into
  `ReferenceKind` in `references.ts` if other records can point at them.
- Platform code writes through narrow structural types (`AuditWriter`, `OutboxWriter`,
  `AuthDatabase`), not the generated Prisma types, and states its host requirements in a header
  comment.
- Read configuration through `ConfigService`. Do not read `process.env` outside
  `src/config/env.ts` and `src/main.ts`. A new variable goes into `envSchema`, `.env.example`, and
  `globalPassThroughEnv` in `turbo.json`.
- The package is CommonJS (no `"type": "module"`). Relative imports have no `.js` extension.
- Classes injected through constructors must be value imports, not `import type`.
- Never log a connection string, a request body, a header, a cookie, a query value, a password, a
  one-time code, a token, a push token (use `maskPushToken`), a storage key, or a signed URL.
- Storage keys are chosen by the API only; signed URLs come only from `AttachmentsService.present`
  for rows loaded through `attachmentVisibilityWhere`. A storage failure becomes 503.
- Outbox handlers are registered from Operations modules, are idempotent (`sourceEventId`), and
  re-check current state. Push text stays generic.

## Known issues

- **Rate limits are in memory per process** (sign-in and upload steps), and so is the decode
  limit; a restart clears them, several instances count separately. Bind a shared store under
  `RATE_LIMITER` before scaling out.
- **Lockout can be used to keep a known account locked** (accepted, ADR-0004).
- **Orphan upload bytes** after a PUT to a still-valid upload URL of a completed attachment; never
  served, never removed (ADR-0006). The purge covers attachments archived while pending, for
  48 hours.
- A lost `startUpload` answer of a start without an attachment `clientId` leaves a second pending
  attachment until the 24-hour cleanup (with a `clientId` the repeat returns the same one).
- Approved logs can still receive declared photos for 30 days (ADR-0008). An edit resent after
  its idempotency key expired, on a log approved meanwhile, is refused although it took effect.
- The idempotency cleanup, like the attachment cleanup, runs in every API process.
- **Push receipts are in memory**; push-token rebinding is accepted (ADR-0007). Notification text
  follows `User.locale`, but only the English catalogue exists (fallback key by key).
- Exports are synchronous and capped at 10,000 rows; the directory is capped at 5,000 entries
  per kind; overview counts are computed on read (ADR-0009).
- The cleanup and the Expo receipt checks run in every API process (harmless, each claims rows
  conditionally).
- **One-time codes are only logged, in development.** Production delivers nothing until a real
  `NotificationSender` is bound, and logs a warning per code.
- **Redaction is by key name** in audit and outbox events.
- **The append-only trigger does not block `TRUNCATE`.**
- **Optimistic locking only on tasks and work logs**, and only when the client sends
  `expectedVersion`; everything else is last-write-wins.
- **Outbox sequences are assigned at insert, not commit**; the consumer's 60-second settle rule
  handles it and re-reads that window every poll.
- **`db:reset` has no guard on its target database.**
- Scope resolution loads every membership, site, and team of the organization once per request;
  every authenticated request also reads the session and the user.
- Old log type definitions are recoverable only from the audit log.
- Memberships, log types, tasks, work logs, and attachments have no restore endpoint (the
  dashboard cannot restore an archived log type).
- Tenancy and scope are enforced in application code only.
- `/health` logs an error on every call while the database is down, is public, and reveals
  whether the database is up. It does not report the storage.
- `nest build` deletes `dist/` under a running dev server.
- Code comments in `packages/shared/src/domain/users.ts` (`listUsersQuerySchema`) and
  `access/rules/user.rules.ts` (`contactVisibility`) say a search matches the username for
  contact-visible users; the service matches the username for admins only.
- `users.service.ts` has a leftover duplicate doc comment above `activationStates`.
- The Swagger description in `main.ts` and the `description` in `package.json` still say
  "Operations App".
- NestJS 12 packages are ESM-only while this package is CommonJS (Node 24 `require` of ESM, and
  `--experimental-vm-modules` in the test scripts).
- Prisma is pinned to exactly `7.10.0` (three packages). Upgrade all three together.
- From PowerShell, `pnpm exec dotenv ... -- <cmd>` drops the arguments after `--`. Use the package
  scripts, or call `node_modules\.bin\dotenv.cmd` directly.
