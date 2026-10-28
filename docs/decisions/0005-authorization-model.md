# ADR-0005: Authorization model and the 404-versus-403 rule

- **Status**: Accepted; amended in part by [ADR-0006](0006-file-storage-and-upload-flow.md)
  (2026-10-17: a `pending` attachment is visible only to its uploader; the API generates
  attachment storage keys, which resolves F5 below) and by
  [ADR-0008](0008-offline-storage-sync-and-conflicts.md) (2026-10-27: typed refusal codes such as
  409 `already_reviewed` and 409 `task_cancelled` where this ADR answered a generic 403 or 409; the
  404-versus-403 rule is kept)
- **Date**: 2026-10-14
- **Phase**: 3 (Authentication & permissions)
- **Amends**: [ADR-0002](0002-flexible-organization-and-scope-model.md) in part (manager and
  admin memberships are always organization-wide; the resolved scope gains `colleagueIds`; the
  record-visibility rule ADR-0002 left open is decided here)

## Context

ADR-0002 gave every user a resolved scope (sites, teams, people) but left open how it applies to
one record, what each role may _do_, how request bodies are checked field by field, and who may
read the audit log and the outbox. In Phase 2 any acting user could read and change everything in
their organization, set `authorId` to someone else, approve their own work log, and read every
audit and outbox event.

The owner's Phase 3 prompt (`docs/prompts/phase-3.md`) fixed the rules: workers see their own
logs and assigned tasks; supervisors everything in their scope plus their own records; managers
the whole organization's operational data; admins everything; the union over several
memberships; server-set author fields; a configurable edit window; nobody approves their own log;
no privilege escalation; admin-only audit; no outbox route in production; role-shaped responses;
404 for records outside scope and 403 for visible records the caller may not change. It also
required **one authorization layer**, not ad-hoc checks in controllers, and a test that fails when
a route declares no policy.

The AI layer (Phase 7) must later read through the same rules, so they had to be callable outside
HTTP.

## Decision

### One layer, two checks

1. **Function level (route).** Every route declares a policy with `@Policy('<resource>.<action>')`
   (or `@Authenticated()` for self-service routes, `@Public()` for sign-in and health). The one
   global guard of the platform (ADR-0004) authenticates, then hands the policy name to the
   host's `RequestAuthorizer` (`REQUEST_AUTHORIZER`, implemented by
   `OperationsRequestAuthorizer` in `src/operations/access/`). It looks the name up in **the policy
   registry** (`policies.ts`, `listPolicies()`), which lists the roles that may use each route.
   An unknown policy name is refused (403, fail closed, logged as a programming error), a route
   with no declaration is refused by the guard, and a user without the role (including a user
   with no active membership at all) gets 403.
2. **Object level (record and fields).** Services obtain the caller's **access context**
   (`AccessService.context()`: user, organization, roles highest first, `isAdmin`,
   `isManagerOrAbove`, `isSupervisorOrAbove`, and the resolved scope), resolved once per request
   and cached on the request's context store. They pass it to **pure rule functions** in
   `access/rules/` that return a `Decision` (`allowed`, or `not_found` / `forbidden` /
   `conflict` with a reason). `enforce()` is the only place a decision becomes an HTTP error.
   Rules never throw and never touch the database, so each one is unit tested as a table.

**Visibility is written once per resource, as data** (`visibility.ts`): a `Visibility` value is
either "everything" or a list of clauses (`authorId IN (...)`, `assignees SOME userId IN (...)`).
Two interpreters read the same value: `isVisible()` for one loaded record and `visibilityWhere()`
for the Prisma filter of a list or a lookup. The predicate and the query filter therefore cannot
drift apart. Relation clauses can require the related records to be non-archived (an archived task
no longer makes its site or its people visible).

### Roles and memberships

- Roles rank `worker < supervisor < manager < admin`. Capabilities are the union over the user's
  active memberships.
- **`manager` and `admin` memberships are always organization-wide**: `orgWide: true` and no sites
  or teams, enforced on create and on the result of an update (400 naming the fields). A stored row
  that says otherwise is read as organization-wide. `supervisor` and `worker` memberships are
  scoped (sites and/or teams, a union, descendants included) and may be organization-wide.

### Visibility per resource

| Resource     | Visible to                                                                                                                                                                                                                                                                                           |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Work log     | Its author; whoever oversees the whole organization (manager, admin, org-wide supervisor); a supervisor when the log's site or team is in scope or its author is one of their people.                                                                                                                |
| Task         | Its assignees; whoever oversees the whole organization; a supervisor when the task's site or team is in scope, an assignee is one of their people, or they created it.                                                                                                                               |
| Site, team   | Everyone when the caller oversees or works in the whole organization; otherwise the caller's scope, the places they work (descendants included), and the places of non-archived tasks assigned to them.                                                                                              |
| Log type     | Every signed-in user of the organization (needed to write a log).                                                                                                                                                                                                                                    |
| User         | Everyone when the caller oversees the whole organization; otherwise themselves, the people of their scope, their **colleagues** (everyone who works at a place they work at, and the supervisors of that place), and the people on their non-archived tasks (co-assignees, creators of their tasks). |
| Attachment   | Whoever can see its work log.                                                                                                                                                                                                                                                                        |
| Organization | Every signed-in user (shape depends on role, below).                                                                                                                                                                                                                                                 |
| Membership   | Admins only (route level).                                                                                                                                                                                                                                                                           |
| Audit event  | Admins only, their organization only. Failed sign-ins for unknown identifiers have no organization and are visible to nobody through the API.                                                                                                                                                        |
| Outbox event | Admins only, and only when `NODE_ENV` is `development` or `test`. In any other environment the controller is `@DevelopmentOnly()`: the guard answers 404, before authentication, for everyone, with the same body as an unknown route.                                                               |

`resolveScope` gained `colleagueIds` (rule 8 in its comment): the people a worker may see by name.
It gives no view of their records.

### Who may do what

- **Managers manage sites, teams, and log types** (with admins). Reason: these are operational
  definitions (where work happens, who does it, what a log records), which is what a manager runs
  day to day; waiting for an admin for each new site or form field would be friction with no
  security benefit. Every change is audited. Admins keep users, memberships, roles, and
  organization settings.
- **Server-set author fields.** `authorId`, `createdById`, and `uploadedById` come from the
  signed-in user. They are not in the request schemas, which are strict, so sending one is a 400.
  The system context of the seed is nobody and cannot author a record.
- **Work logs.** Anyone creates their own, as `draft` or `submitted` only; references in the body
  must be visible (else 422). Only the author edits content, only while not `approved` and within
  the organization's edit window (`organization.settings.workLogEditWindowHours`, default 24,
  counted from `createdAt`, the edge inclusive). Status moves are a fixed table: the author moves
  `draft` to `submitted`, `submitted` to `draft`, and `rejected` to `submitted` under the edit
  rule; a reviewer (supervisor or above who can see the log) moves `submitted` to `approved` or
  `rejected`, and `approved` or `rejected` back to `submitted`, **never on their own log**. A move
  not in the table is 409 for everyone. Archiving: the author under the edit rule, or a reviewer.
  Attachments follow the archive rule of their log.
- **Tasks.** A supervisor creates, edits, assigns, and archives tasks placed at a site or team of
  their scope (else 403), with visible references (else 422) and assignees among their people
  (else 422); a task with neither site nor team can be created only by an organization-wide
  caller. Managers and admins act organization-wide. Whoever may manage a task sets any status; an
  assignee may move it between `todo`, `in_progress`, `blocked`, and `done`, may not cancel it,
  and may not change a cancelled task.
- **Users.** Admins create, archive, restore, and change any field, and issue activation and
  reset codes. Everyone else may change only their own `displayName`.
- **No escalation.** Nobody grants or changes a membership above their own highest role or outside
  their own scope, checked on the membership as it is and as it will be. **The last active admin**
  of an organization cannot be archived, demoted, or have the admin membership archived (409); the
  check runs under a per-organization PostgreSQL advisory lock, so two concurrent changes cannot
  both pass it.
- Archiving a user, archiving a membership, or reducing one (lower role, less scope) revokes the
  holder's sessions in the same transaction.

### Role-shaped responses

- **Users** come in three explicit shapes with a `profile` discriminator: `basic` (id, display
  name, roles), `contact` (adds email, phone), `full` (adds organization, username, memberships,
  activation state, timestamps). `full` for admins and for oneself; `contact` for a manager, and
  for a supervisor about their people; `basic` otherwise. A search matches email and phone only
  of users the caller sees in at least `contact` shape, and username only for admins; sorting by
  email is refused (403) unless the caller sees every email.
- **Organization** has `view: summary` (id, name, slug, edit window) for everyone and `view: full`
  (adds settings and timestamps) for admins.
- Tasks name people by id only.

### The 404-versus-403 rule

- **404** when the record does not exist, belongs to another organization, **or is outside the
  caller's visibility**. The three cases are indistinguishable, so the existence of a record is
  never revealed.
- **403** when the caller can see the record but may not do this to it, and when the caller's role
  may not use the route at all.
- **409** when the record's state forbids the change for everyone (archived, impossible status
  move, last admin, duplicate unique value).
- **422** when a body refers to a record that does not exist, is archived, is in another
  organization, or is outside the caller's visibility (the same answer for all four).
- **Order**: the guard's checks come first (401, the CSRF 403, the route-level 403), then body
  validation (400), then the service: 404, then 403, then 409. Exception: a work-log status move
  that is not in the table at all answers 409 to anyone who can see the log.

**Documented limits** (accepted, from the security review):

- `clientId` reuse: retrying a work log create returns the stored log only to its author; another
  user who sends the same `clientId` gets 409. That reveals that some log with that UUID exists, a
  negligible oracle for a client-generated random UUID (F7).
- Attachment `storageKey` is still chosen by the client and unique per organization, so a
  duplicate answers 409 even when the other attachment is invisible to the caller. It goes away in
  Phase 4, when the API generates the key (F5).
- Identifier conflicts on user create and update name the field (409); those routes are
  admin-only, and admins see every identifier anyway.

### Test strategy

- Pure rules and visibility have unit tables (`access/rules/*.spec.ts`, `visibility.spec.ts`,
  `access.spec.ts`).
- `route-policies.spec.ts` boots the real modules, enumerates every route, and fails when a route
  declares none of `@Public()`, `@Authenticated()`, `@Policy(...)`, when a policy is not in the
  registry, or when a registry entry is unused; it also checks that the guard fails closed.
- `permissions-matrix.int-spec.ts` (535 tests) checks every cell of the matrix in
  `ARCHITECTURE.md` over real HTTP with real sessions, for every role and scope of a fixture
  (`test/support/matrix-world.ts`), a whole row per test so a failure lists every wrong cell.
  `permissions-cases.int-spec.ts` covers the named cases (a worker cannot see another worker's
  logs, a supervisor cannot see outside scope, the multi-membership union, nobody approves their
  own log, no escalation through memberships, server-set author fields).

## Reasons

- **A registry plus a single guard** makes "every route has a policy" checkable by a test, and
  answers the route-level question before any service code runs.
- **Pure rules over a context** are testable without a database and reusable by the AI layer
  (Phase 7), which must read through the same rules on behalf of a user.
- **One visibility definition for both the predicate and the query** removes the most common
  source of broken object-level authorization: a list filter that disagrees with the detail check.
- **404 for invisible records** stops enumeration of ids across scopes (OWASP API1).

## Tradeoffs

- The access context is resolved per request (a few small queries); nothing is cached across
  requests, so a membership change applies on the very next request.
- Visibility filters add joins to list queries (`assignees`, `tasks`). Fine at this scale;
  watch the query plans if lists grow.
- Two places describe the rules in prose (this ADR and the matrix in `ARCHITECTURE.md`); the
  matrix suite is what keeps them honest.
- Tenancy and scope are still enforced in application code only (ADR-0002); a missed filter in a
  new query would leak. The route-policy test does not cover object-level checks; the matrix suite
  does, for the routes that exist.

## Alternatives considered

| Alternative                                      | Why not                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PostgreSQL row-level security                    | Strongest guarantee, but needs a per-request database role or session variable, which conflicts with the pooled Prisma client, and it cannot express the 404/403 distinction or field-level rules. Phase 8.  |
| A policy library (CASL or similar)               | A second rule language next to Prisma filters; its conditions would still have to be translated into Prisma queries, which is where drift happens. The `Visibility` value does exactly that, with less code. |
| Ad-hoc checks in controllers or services         | What the prompt rules out: impossible to prove complete, easy to forget on a new route.                                                                                                                      |
| 403 for records outside scope                    | Reveals that the id exists.                                                                                                                                                                                  |
| Admin-only management of sites, teams, log types | Possible by changing three registry entries; rejected because it puts routine operational changes behind the one role that should be rare.                                                                   |

## Consequences

- A new route needs `@Policy`, `@Authenticated`, or `@Public`; a new policy name must be added to
  `policies.ts` (the route-policy test fails otherwise) and to the matrix in `ARCHITECTURE.md` and
  the matrix suite.
- Services get the caller from `AccessService.context()` and use the rule functions and the
  `xxxVisibilityWhere` filters; they never check roles directly and never take `organizationId` as
  an argument from a controller.
- Code without a request (the seed) runs under `AccessService.runAsSystem(organizationId, ...)`,
  an admin context that is nobody's author and that cannot be entered inside a request.
- Changing these rules means a new ADR that supersedes this one.
