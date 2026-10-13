# ADR-0002: Flexible organization and scope model

- **Status**: Accepted
- **Date**: 2026-10-13
- **Phase**: 2 (Backend core)

## Context

The product (HZ) is being built before the client's company structure is known. Different workers
give input, and the structure may change after the product is in use: there may be sites without
teams, teams without sites, people who work in several teams, supervisors who look after a site, a
team, or both, and later sub-sites or departments.

Two questions were open at the end of Phase 1 and had to be answered before any data model:

- Is scope by team, by site, or both, and can a user belong to more than one?
- Is a single tenant enough, or must the model be multi-tenant so the same platform can host other
  clients?

Permission enforcement is Phase 3. Phase 2 needed the data, and one place that answers "what may
this user see", so that Phase 3 only has to wire that answer into sign-in and every route.

## Decision

**Tenant.** `Organization` is the tenant. Every business record carries `organizationId`. One
organization is in use today; the model is multi-tenant-ready, not multi-tenant-operated (nothing
creates a second organization except the tests).

**Users.** A `User` belongs to exactly one organization (`User.organizationId`; email is unique per
organization, not globally).

**Structure.** `Site` (a physical location or project) and `Team` (a group of people) are both
optional and independent of each other. Each has an optional `parentId` pointing at a record of the
same kind, so a hierarchy can be added later without a schema change. The API rejects a parent in
another organization, an archived parent, a record as its own parent, and a move below one of its
own descendants.

**Membership = role + scope.** A `Membership` gives one user one role (`worker`, `supervisor`,
`manager`, `admin`) over a scope. The scope is any combination of:

- `orgWide = true`: the whole organization;
- any number of sites (`MembershipSite` rows);
- any number of teams (`MembershipTeam` rows).

Sites and teams on one membership are a **union**, never an intersection. A user may hold several
memberships, so one person can be a worker in two teams and a supervisor of a site at the same
time. "Belongs to a team" and "is assigned to a site" are not separate concepts: they are worker
memberships scoped to that team or site.

**Archive, never delete.** Users, sites, teams, memberships, log types, tasks, work logs, and
attachments have `archivedAt`. Nothing has a delete endpoint, and foreign keys are `ON DELETE
RESTRICT` (the membership scope rows and task assignee rows cascade with their parent, which is
itself never deleted). History and the audit trail stay intact.

**Scope resolution.** One pure function, `resolveScope` in
`apps/api/src/operations/scope/resolve-scope.ts`, turns a user's memberships into a
`ResolvedScope` (`{ active, roles, orgWide, siteIds, teamIds, userIds, memberOf }`, schema in
`@ops/shared`). `ScopeService` loads the data and calls it. The rules as implemented:

1. An archived membership grants nothing. An archived user has no scope: `active` is false, there
   are no roles, and only their own id is listed.
2. A `worker` membership gives no view of other people. It records where the user works: its sites
   and teams, descendants included, go to `memberOf`.
3. A `supervisor`, `manager`, or `admin` membership gives a view over its scope: the whole
   organization when `orgWide`, otherwise the union of its sites and its teams, each with all
   descendants through `parentId`. The three roles resolve to the same visibility; what each may
   _do_ is a Phase 3 permission question.
4. Several memberships combine as a union.
5. Visible users are the user themselves plus every user holding an active membership at a visible
   site or team. A worker membership counts at its sites and teams and all their descendants; an
   oversight membership counts only where it is scoped directly, so a site supervisor does not see
   the regional manager above them. An organization-wide membership of somebody else does not make
   that person visible to a site or team supervisor. When the view is organization-wide,
   `userIds` is the literal `'all'`.
6. A user with no active membership sees only themselves.
7. Archived sites and teams still count as scope and still pass scope down to their descendants,
   and archived colleagues stay listed, so past records remain visible to whoever supervised them.

**Tenancy is enforced in application code.** Every service takes the organization from the acting
user and filters on it. `assertActiveReferences` is the one place that checks that ids in a
request body belong to the caller's organization and are not archived. A record of another
organization is reported exactly like one that does not exist.

## Reasons

- **One mechanism covers every structure the client has described so far.** A company with only
  teams, only sites, both, or a hierarchy uses the same three tables. Changing the structure is a
  data change, not a migration.
- **Role is attached to the scope, not the user**, because the same person can hold different
  roles in different places.
- **Union is the least surprising rule.** A supervisor "of the depot and of the logistics team"
  expects to see both, not only the logistics people who are at the depot.
- **A pure function is easy to prove.** The resolution takes plain data and returns plain data, so
  every membership combination is unit tested without a database, and Phase 3 can reuse it for
  HTTP routes and for the AI layer alike.
- **`organizationId` on every row from the first migration** costs little now and is expensive to
  retrofit. It also keeps the audit log and outbox usable by other Kaneri products.
- **Archive instead of delete** keeps foreign keys valid and keeps the audit trail meaningful.

## Tradeoffs

- **Nothing enforces scope yet.** In Phase 2 any acting user can read and change everything in
  their own organization. The resolution exists only as two read-only inspection endpoints
  (`GET /scope/me`, `GET /users/:id/scope`).
- **The database does not enforce tenancy.** A bug in a service could link a row to a site of
  another organization; only the application check prevents it. The integration suite
  `tenant-isolation.int-spec.ts` covers the endpoints that exist, and every new endpoint needs the
  same test.
- **No way to express an intersection** ("only the logistics team at the harbour site"). It would
  need a new rule or a new kind of scope row.
- **The resolution reads every membership, site, and team of the organization on each call.** That
  is fine for one company; it must be cached per request before Phase 3 calls it on every route.
- **One organization per user.** A contractor who works for two client organizations needs two
  user records.
- **Archived structure keeps granting visibility.** Archiving a site does not hide its history from
  its supervisors. That is intended, but it means archiving is not a way to revoke access;
  archiving the membership is.
- **Visibility of a record is not defined yet.** The resolved scope lists sites, teams, and users,
  but the rule for combining them for one record is not written (see Consequences).

## Alternatives considered

| Alternative                                                  | Why not                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global users with per-organization memberships               | Needed only when one identity spans tenants. It makes email uniqueness, sign-in, and "which organization is this request for" harder, for a case the client does not have.                   |
| A separate team-member (and site-assignment) table           | Two ways to say "this person is in this team" (a member row and a membership), which drift apart. A worker membership scoped to the team says the same thing with one mechanism.             |
| A fixed hierarchy (organization, then site, then team, user) | Assumes every team belongs to one site and every worker to one team. The client already has people in two teams and teams that span sites.                                                   |
| Intersection semantics for sites and teams on one membership | Surprising for the common case, and an empty intersection silently grants nothing. Union can be narrowed later with an explicit rule; an intersection default cannot be widened safely.      |
| Composite foreign keys on (`organizationId`, `id`)           | Would make cross-tenant links impossible at the database level, but Prisma supports them awkwardly and every relation would need a compound key. Revisit if a second tenant is onboarded.    |
| PostgreSQL row-level security                                | The strongest guarantee, but it needs a per-request database role or session variable, which conflicts with the pooled Prisma client used today. Revisit in Phase 8 with real multi-tenancy. |
| Hard delete with cascades                                    | Destroys the history the audit log and the reports depend on.                                                                                                                                |

## Consequences

- Every new business table carries `organizationId`, an index that starts with it, and
  `archivedAt` if records of that kind can be retired.
- Every service method takes `organizationId` from the acting user (`requireActor()`), never from
  the request body or the URL, and validates referenced ids with `assertActiveReferences`.
- Every new endpoint gets a tenant-isolation test: a user of another organization receives a plain
  404 for a record id and a 422 for a reference in a body.
- **Phase 3 must decide**, in its own ADR:
  - the **record-visibility rule**: how `siteIds`, `teamIds`, `userIds`, and `memberOf` combine
    for one record. `resolvedScopeSchema` documents the intended reading (visible when the record
    belongs to a visible site, a visible team, or a visible user), but the edge cases are open,
    for example a worker with no site or team whose work log carries a supervisor's site;
  - **per-request caching** of the resolved scope;
  - what each role may **do** (the resolution only answers what a role may see), including
    per-field rules for request bodies and status transitions.
- If a second organization is onboarded, revisit database-level tenancy (composite keys or
  row-level security) before it goes live.
- Changing these rules means a new ADR that supersedes this one.
