import { ROLES, roleRank, type Role } from '@ops/shared';

/**
 * What the signed-in user's roles let them do in the dashboard: which pages and buttons to show.
 *
 * UX ONLY. This mirrors the API's policy registry (`apps/api/src/operations/access/policies.ts`)
 * and the permissions matrix in ARCHITECTURE.md so that the dashboard does not offer what the
 * server will refuse. It is not a security control: the API checks every request, filters every
 * list by the caller's scope, and answers 403 / 404. Never use these flags to hide data the API
 * returned; never assume a flag means the server will accept the action (object-level rules such
 * as scope, authorship and the edit window still apply).
 */
export interface Capabilities {
  /** The highest role, or null without an active membership. */
  role: Role | null;
  roles: readonly Role[];
  /** Supervisor or above: the dashboard is for them (workers use the mobile app). */
  usesDashboard: boolean;
  /** Approve and reject work logs (never their own: see `canReviewWorkLog`). */
  reviewWorkLogs: boolean;
  /** Create, edit, assign and archive tasks (a supervisor within their scope). */
  manageTasks: boolean;
  /** The overview numbers, the map, exports and the printable report. */
  viewOverview: boolean;
  exportData: boolean;
  /** People list (managers view, admins manage). */
  viewPeople: boolean;
  /** Users, invitations, codes, sessions, memberships. */
  manageUsers: boolean;
  /** Structure page: sites, teams and log types. */
  viewStructure: boolean;
  manageStructure: boolean;
  /** Audit log (admin only). */
  readAudit: boolean;
  /** Organization settings (admin only). */
  editSettings: boolean;
}

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** Capabilities from the role names of `GET /auth/me` (`user.roles`). */
export function capabilitiesFor(roleNames: readonly string[]): Capabilities {
  const roles = roleNames.filter(isRole);
  const rank = roles.reduce((highest, role) => Math.max(highest, roleRank(role)), -1);
  const atLeast = (role: Role) => rank >= roleRank(role);
  const role = rank < 0 ? null : (ROLES.find((candidate) => roleRank(candidate) === rank) ?? null);
  return {
    role,
    roles,
    usesDashboard: atLeast('supervisor'),
    reviewWorkLogs: atLeast('supervisor'),
    manageTasks: atLeast('supervisor'),
    viewOverview: atLeast('supervisor'),
    exportData: atLeast('supervisor'),
    viewPeople: atLeast('manager'),
    manageUsers: atLeast('admin'),
    viewStructure: atLeast('manager'),
    manageStructure: atLeast('manager'),
    readAudit: atLeast('admin'),
    editSettings: atLeast('admin'),
  };
}

/** Capability flags that gate whole pages (see `src/lib/navigation.ts`). */
export type PageCapability = {
  [Key in keyof Capabilities]: Capabilities[Key] extends boolean ? Key : never;
}[keyof Capabilities];

/**
 * Whether to offer Approve / Reject for a log: a reviewer, not its author, and a status the
 * review moves start from. The server refuses self-approval anyway (403); the dashboard never
 * shows the buttons for it (Phase 6 prompt).
 */
export function canReviewWorkLog(
  capabilities: Capabilities,
  callerId: string,
  log: { authorId: string; status: string; archivedAt: string | null },
): boolean {
  return (
    capabilities.reviewWorkLogs &&
    log.authorId !== callerId &&
    log.archivedAt === null &&
    (log.status === 'submitted' || log.status === 'approved' || log.status === 'rejected')
  );
}
