# ADR-0013: Production bootstrap of the real organization

- **Status**: Accepted
- **Date**: 2026-11-17
- **Phase**: 8 (Hardening & release), owner request: "the final app that we will submit ...
  clear synthetic stuff"

## Context

Until now the only way to create an organization was the demo seed (`pnpm db:seed`), which adds
invented sites, teams, people, tasks and work logs. No endpoint creates organizations (ADR-0002),
and in production nobody can sign in to create the first administrator: the demo seed issues
activation codes in production, and AGENTS.md forbids printing a one-time code. A release needs a
clean way to create the deployment's real organization and its first administrator, with no
synthetic data.

## Decision

1. **Command.** `pnpm db:bootstrap` (root) compiles the API like the seed and runs
   `apps/api/prisma/bootstrap.ts`, which calls `bootstrapOrganization`
   (`src/operations/seed/bootstrap-organization.ts`). It creates the organization (one direct,
   audited row, like the seed) and, under `AccessService.runAsSystem`, the administrator through
   `UsersService.createWithFirstPassword` and an org-wide `admin` membership through
   `MembershipsService`. Nothing else: sites, teams, log types and people are set up by that
   administrator in the dashboard.
2. **Inputs** come from environment variables (`BOOTSTRAP_ORG_NAME`, `BOOTSTRAP_ORG_SLUG`,
   `BOOTSTRAP_TIME_ZONE`, `BOOTSTRAP_LOCALE`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`,
   `BOOTSTRAP_ADMIN_PASSWORD`), documented in `.env.example`, so no secret is typed into a shell
   history. They are read only by this command (not validated at API boot, not in `turbo.json`).
3. **The first password.** `AuthAdminService.setFirstPassword` sets a password only for a user
   who has none (409 otherwise), in every environment, applying the password policy. It never
   replaces a password, so it cannot be used to take over an account.
   `UsersService.createWithFirstPassword` accepts only the system context (`runAsSystem`, which
   cannot run inside a request); no route calls it. The password is never printed, logged,
   stored as is, or written to the audit or outbox (tested).
4. **Order and idempotency.** An existing slug changes nothing. The password policy is checked
   before anything is written, so a refused password leaves no organization without an
   administrator.

## Consequences

- A production database can start empty (`db:deploy`, then `db:bootstrap`); the demo seed stays
  for development only.
- The clients' `NEXT_PUBLIC_ORGANIZATION_SLUG` / `EXPO_PUBLIC_ORGANIZATION_SLUG` must be set to
  the bootstrapped slug (the command says so).
- The operator must remove `BOOTSTRAP_ADMIN_PASSWORD` from the environment after the run; the
  administrator can change the password later through the usual reset flow.
- Tests: `test/bootstrap.int-spec.ts` (creates and signs in, no demo rows, idempotent, weak
  password and bad input refused before any write, refused outside the system context).
