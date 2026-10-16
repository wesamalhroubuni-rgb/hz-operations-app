# ADR-0004: In-house authentication behind a platform interface

- **Status**: Accepted
- **Date**: 2026-10-14
- **Phase**: 3 (Authentication & permissions)

## Context

Until Phase 3 the API took the acting user from a development-only header (`x-dev-user-id`), so
anyone who could reach it could act as anyone. Phase 3 had to replace that with real sign-in
before the API can be exposed to real users.

Constraints from the owner's Phase 3 prompt (`docs/prompts/phase-3.md`) and the product:

- **No public sign-up.** An admin creates users; a new user sets their own password with an
  expiring one-time code; an admin can issue a reset code. Email and SMS delivery are not built.
- **Field workers may have no email.** They must be able to sign in with a phone number or a
  username.
- Two clients with different storage: a browser (web dashboard) and a phone app (Expo).
- Sign-out must be immediate, also when an admin archives a user or removes a membership.
- Brute-force protection, generic errors, and an audit trail of every security event, with no
  password, code, or token ever stored in audit or outbox rows.
- An external identity provider or company SSO may be wanted later, and must then be addable
  without touching the business modules.
- Authentication is a reusable Kaneri platform component: it lives in `src/platform` and must not
  import `src/operations`.

## Decision

**In-house authentication in the platform module `apps/api/src/platform/auth/`, behind narrow
seams.** Business modules know only `RequestContext.actor()` (`{ userId, organizationId,
sessionId? }`) and `AuthAdminService` (issue a one-time code, revoke a user's sessions, set a seed
password, read the activation state). The host tells the platform about roles and the
organization name through `AUTH_PROFILE_PROVIDER`, and about route permissions through
`REQUEST_AUTHORIZER` (ADR-0005). The platform's tables (`AuthCredential`, `AuthOneTimeCode`,
`AuthSession`, `AuthRefreshToken`, migration `20261014090000_auth`) hold hashes only and have no
foreign keys to business tables.

**One global guard** (`AuthGuard`) authenticates every request that is not `@Public()`. There is
no other way to obtain an acting user.

### Identifiers

- A user signs in with an **email, phone number, or username**. A user has at least one; each is
  unique within the organization (`User.email` became optional, `User.username` is new).
- Normalised before storing and before lookup: email and username lower-case and trimmed; phone
  as digits with an optional leading `+` (spaces, dashes, parentheses removed). The API
  (`identifiers.ts`) and `@ops/shared` (`normalizePhone`) must normalise identically.
- The kind is inferred from what was typed: contains `@` is an email; only digits, `+`, spaces,
  dashes, and parentheses with at least 6 digits is a phone; anything else is a username.
  Usernames are 3 to 32 characters of `a-z 0-9 . _ -` and must contain a letter, so the three
  namespaces cannot collide.

### Organization slug rule

`POST /auth/login` takes an optional `organizationSlug`. With it, the lookup is inside that
organization. **Without it, sign-in succeeds only while exactly one active organization exists**,
and the identifier must then name exactly one non-archived user. As soon as a second active
organization exists, a slug is required. Otherwise an admin of one organization could create the
same identifier as a user of another and block that user's slug-less sign-in, or probe which
identifiers exist elsewhere (security review finding F2). The web and mobile apps always send the
slug of their deployment (`NEXT_PUBLIC_ORGANIZATION_SLUG`, `EXPO_PUBLIC_ORGANIZATION_SLUG`;
`hz-demo` in `.env.example`).

### Passwords

- **argon2id** through `@node-rs/argon2` (prebuilt binaries, no install script), with the OWASP
  minimum parameters: 19,456 KiB memory, 2 passes, parallelism 1. Hashes are PHC strings, so the
  parameters can be raised later without invalidating stored hashes.
- New passwords: 10 to 128 characters; not one or two characters repeated; not in a small list of
  well-known passwords; not equal to, or containing (4 characters or more), the user's email,
  local part, username, phone, or display name. Login itself does not apply the policy.
- Unknown accounts and accounts without a password get a dummy verification, so the response
  time does not reveal whether an account exists. A locked account is verified too.

### Sessions and tokens

- **Access token**: a JWT signed with HS256 by our own code on `node:crypto` (no JWT library). The
  header must be exactly `{"alg":"HS256","typ":"JWT"}`; `iss`, `aud`, `exp`, and `iat` are always
  checked (60 seconds of clock skew for `iat`). Claims `sub` (user), `org`, `sid` (session).
  Lifetime 15 minutes (`AUTH_ACCESS_TOKEN_TTL_SECONDS`). The signing key, the CSRF key, and the
  identifier-fingerprint key are each derived from `AUTH_ACCESS_TOKEN_SECRET`.
- **Refresh token**: 256 random bits, stored as SHA-256, **single use**. Each refresh marks the
  token used with a conditional update (`WHERE usedAt IS NULL`), so of concurrent requests exactly
  one wins, and issues the next token of the same session (the "family").
- **Reuse detection with a grace window.** A used token presented again within
  `AUTH_REFRESH_REUSE_GRACE_SECONDS` (default 10) is treated as the loser of a race between two
  browser tabs: 401, nothing issued, nothing revoked, and the web cookies are left alone. Later
  than that it is reuse of a stolen or replayed token: the whole session is revoked
  (`refresh_reuse`) and `auth.refresh_reuse_detected` is audited.
- **Expiry**: sliding 30 days per refresh token (`AUTH_REFRESH_TOKEN_TTL_DAYS`), absolute 90 days
  per session (`AUTH_SESSION_ABSOLUTE_TTL_DAYS`, never shorter than the sliding value).
- **The database is asked on every authenticated request**: the session exists, is not revoked or
  expired, and matches the token's user and organization; the user exists and is not archived.
- Sessions record client kind, device name, user agent, and IP address. A user can list their own
  sessions and end one (`GET /auth/sessions`, `DELETE /auth/sessions/:id`; another user's session
  id answers 404). `POST /auth/logout-all` ends every session of the user.
- Setting a password with a code ends every session of the user. Changing one's own password ends
  the other sessions and keeps the current one. Archiving a user, archiving a membership, or
  reducing a membership revokes that user's sessions in the same transaction.

### Web: cookies and CSRF

- A `web` login sets two cookies and returns no tokens in the body: `access_token` (`Path=/`) and
  `refresh_token` (`Path=/auth`), both `HttpOnly; SameSite=Lax`, `Secure` outside development and
  test, and `Domain` only when `AUTH_COOKIE_DOMAIN` is set. A web session is accepted only from the
  cookie; a request that carries any `Authorization` header never falls back to the cookie.
- **CSRF, two independent barriers** for every cookie-authenticated request that is not `GET`,
  `HEAD`, or `OPTIONS`:
  1. the `Origin` header must be exactly one of `CORS_ORIGINS` (a missing `Origin`, `null`, or
     several values are refused);
  2. the `x-csrf-token` header must equal `base64url(HMAC-SHA256(key, sessionId))`. The token is
     bound to the session, stored nowhere, survives refreshes, and is returned in the body of
     login, refresh, and `GET /auth/me` (so a reloaded page gets it back).
- `POST /auth/login` (with `client: "web"`), `POST /auth/refresh` (from the cookie),
  `POST /auth/set-password`, and `POST /auth/logout` rely on the **Origin check alone**: login,
  refresh, and set-password have no session yet to bind a token to (a request that names an
  origin must name an allowed one; a mobile call without `Origin` is let through where no cookie
  is involved). For logout the reasoning is: it must work with an expired access token (the page
  may have been idle), its worst case under a forged request is a forced sign-out of the victim,
  and a foreign origin is refused anyway. Requiring a CSRF token there would add little and break
  sign-out after a long idle period.
- Every answer of `/auth/*` carries `Cache-Control: no-store`.

### Mobile: bearer tokens

A `mobile` login returns `tokens` (access, refresh, refresh expiry) in the body and sets no
cookies. The app keeps them in Expo SecureStore (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`) and sends
`Authorization: Bearer`. A mobile session is accepted only through the header. It renews with
`refreshToken` in the body and names its session by refresh token at logout, so sign-out works
with an expired access token. No CSRF token is needed: there is no ambient credential to ride on.

### One-time codes

80 random bits shown as `XXXX-XXXX-XXXX-XXXX` (an alphabet without 0, 1, I, O; any case, dashes
optional), stored as SHA-256, single use (conditional update), expiring (activation 72 hours,
reset 60 minutes; configurable). Issuing a new code cancels the earlier unused codes of the same
purpose; setting a password cancels every unused code of the user. A wrong, used, or expired code
answers 422 with one message; a password the policy refuses answers 400 and does not use the code
up. Delivery goes through the `NotificationSender` interface (`src/platform/notifications/`); the
only implementation logs that a code was issued and, **in development only**, the code and the
link (`WEB_APP_URL/activate?code=...`). The admin's API response carries the code and link in
development only; elsewhere both are null.

### Brute force

- **Rate limits** behind the `RateLimiter` interface, in-memory fixed windows per process: login
  20 per minute per IP and 10 per 5 minutes per identifier; refresh 120 per minute per IP and 10
  per minute per token; set-password 10 per minute per IP and 5 per 10 minutes per code;
  change-password 5 per 5 minutes per user. Over the limit: 429 `rate_limited` with
  `Retry-After`. The per-IP limits use the socket address unless `TRUST_PROXY_HOPS` names the
  number of reverse proxies to trust (security review finding F3).
- **Lockout**: after `AUTH_MAX_FAILED_LOGINS` (5) consecutive failures the account is locked for
  `AUTH_LOCKOUT_MINUTES` (15), stored on `AuthCredential`. Attempts during a lock neither count
  nor extend it. The failure counter is incremented only while no lock is in force (a conditional
  update re-checked by PostgreSQL), so concurrent wrong passwords cannot clear an active lock
  (security review finding F1, covered by a burst test). A successful sign-in or any password set
  clears the counter and the lock.
- **Generic answers**: every failed sign-in (unknown identifier, wrong password, locked, archived,
  not activated) answers the same 401 `unauthenticated` "The sign-in details are not correct".

### Audit

Security events are written through `AuditService` with entity type `auth`, and **never to the
outbox**: `auth.login_succeeded`, `auth.login_failed` (reason `bad_password`, `locked`,
`not_activated`, `unknown_identifier`), `auth.locked_out`, `auth.logout`, `auth.logout_all`,
`auth.session_revoked`, `auth.refresh_reuse_detected`, `auth.code_issued`, `auth.activated`,
`auth.password_reset`, `auth.password_changed`. A failure for an identifier that names nobody is
stored with **no organization** and only a keyed HMAC fingerprint of what was typed. Passwords,
codes, and tokens are never put in a payload (key-name redaction exists as a second line, but is
not relied on).

### Boot refusals

The API validates its environment at boot. `AUTH_ACCESS_TOKEN_SECRET` must be at least 32
characters everywhere; in production a placeholder-looking or repetitive secret is refused, and
`WEB_APP_URL` must be `https://`. `DEV_AUTH_ENABLED` no longer exists.

## Reasons

- **No external dependency or account is needed now**, the data stays in the client's database,
  and the rules the prompt asks for (phone and username sign-in, admin-issued codes, immediate
  revocation, one audit trail) are all under our control.
- **The seams keep the choice reversible.** Business modules never see credentials, so an
  external provider changes the platform module only.
- **A database check on every request** is what makes sign-out, archiving, and membership removal
  take effect on the very next request, which the prompt requires.
- **Cookies for the browser** keep tokens out of JavaScript (XSS cannot read them); **bearer
  tokens for the phone** fit native HTTP and SecureStore, and avoid cookie jars on mobile.
- **A stateless, session-bound CSRF token** needs no storage and survives token rotation.

## Tradeoffs

- **We own security-critical code**: hashing parameters, token verification, rotation, CSRF. It is
  covered by unit tests, integration suites (`auth-login`, `auth-sessions`, `secrets`), and an
  adversarial review, but an external identity provider would carry that burden for us.
- **One database round trip per request** for the session and user. Acceptable at this scale;
  revisit with a short cache only if it shows up in measurements, accepting the revocation delay.
- **The grace window**: a thief who replays a refresh token within 10 seconds of its rightful use
  is not detected by that replay (and gets nothing from it). Set the grace to 0 to treat every
  replay as reuse, at the cost of signing out users whose tabs renew at the same moment.
- **Rate limits are per process and in memory.** Several API instances each count separately, and
  a restart forgets everything. A shared store (Redis or PostgreSQL) must be bound under
  `RATE_LIMITER` before scaling out (Phase 8).
- **Lockout is a targeted denial of service** (finding F4, accepted): anyone who knows an
  identifier can keep that account locked by sending wrong passwords. The per-identifier rate
  limit slows it; an admin password reset clears the lock. A CAPTCHA or risk-based lock would be
  the next step if it becomes a problem.
- **No delivery of codes yet**: in production an admin must pass the code on by hand, and the code
  is shown nowhere outside development. A real email or SMS sender is Phase 8 work.
- Behind a reverse proxy, `TRUST_PROXY_HOPS` must be set exactly; too low and every client shares
  the proxy's IP limit, too high and clients can choose their own IP.

## Alternatives considered

| Alternative                                  | Why not now                                                                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External identity provider or company SSO    | Out of scope for Phase 3 per the prompt; needs a provider decision, accounts, and costs; phone-or-username sign-in for workers without email is awkward in many providers. The seams above let it be added later. |
| Server-side opaque session ids only (no JWT) | Equivalent security since we check the database anyway, but a signed token lets the guard reject garbage before a query and carries the session id. Kept small (three claims).                                    |
| Long-lived access tokens without refresh     | Revocation would depend on the database check alone and a stolen token would be usable for long; rotation with reuse detection limits the damage of a leaked refresh token.                                       |
| Tokens in `localStorage` for the web         | Readable by any injected script.                                                                                                                                                                                  |
| Double-submit CSRF cookie                    | Needs a readable cookie and is weaker when subdomains are not trusted; the HMAC token bound to the session needs no extra cookie.                                                                                 |
| bcrypt or scrypt                             | argon2id is the current OWASP first choice; `@node-rs/argon2` ships prebuilt binaries, so no build script had to be allowed.                                                                                      |
| A JWT library (`jsonwebtoken`, `jose`)       | Algorithm negotiation is the usual source of JWT bugs; a fixed HS256 header checked byte for byte on `node:crypto` is less code to trust.                                                                         |
| Sign-in without an organization slug, always | Cross-tenant blocking and probing once a second organization exists (F2).                                                                                                                                         |

## Consequences

- Every route declares `@Public()`, `@Authenticated()`, or `@Policy(...)` (ADR-0005); the guard
  refuses anything else.
- **How SSO plugs in later**: an identity-provider callback route in `src/platform/auth/` verifies
  the external assertion, maps it to a `User` of the organization (a new mapping table keyed by
  issuer and subject), and then creates a normal `AuthSession` through `SessionService`. Cookies,
  CSRF, the guard, revocation, the audit events, and every business module stay as they are.
  Password sign-in can then be switched off per organization.
- Rate limiting must move to a shared store, `TRUST_PROXY_HOPS` must be set in deployment, and a
  real `NotificationSender` must be bound before production (Phase 8).
- Production requires HTTPS, the web app and the API on the same site (or `AUTH_COOKIE_DOMAIN` set
  to the parent domain), and the exact web origin in `CORS_ORIGINS`.
- Integration tests authenticate through the harness (`as(userId)` opens a real session); there is
  no test-only bypass in the running application.
- Changing these rules means a new ADR that supersedes this one.
