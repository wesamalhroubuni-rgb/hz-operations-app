import { ROLES, type Role } from '@ops/shared';

/**
 * The policy registry: every policy name a route can declare with `@Policy('<name>')`, the
 * roles that may use such a route AT ALL (the function-level rule), and what the route does.
 *
 * This is the first of two checks. A role listed here still only reaches the records and the
 * actions the object-level rules in `./rules` allow (scope, authorship, edit window, ...); the
 * description says so where it matters.
 *
 * A user's capabilities are the union over their active memberships, so holding any one of the
 * listed roles is enough. A policy name that is not in this list is refused: fail closed.
 *
 * The permissions matrix in ARCHITECTURE.md is written from this list, and a test asserts that
 * every route of the application declares `@Public()`, `@Authenticated()` or one of these.
 */
export interface PolicyDefinition {
  /** Roles that may use the route. Holding one of them is enough. */
  roles: readonly Role[];
  description: string;
}

const EVERYONE: readonly Role[] = ROLES;
const SUPERVISORS_UP: readonly Role[] = ['supervisor', 'manager', 'admin'];
const MANAGERS_UP: readonly Role[] = ['manager', 'admin'];
const ADMINS: readonly Role[] = ['admin'];

export const POLICIES = {
  'organization.read': {
    roles: EVERYONE,
    description: 'Read the organization: name and slug for everyone, settings for admins.',
  },
  'organization.update': {
    roles: ADMINS,
    description: "Change the organization's name and settings.",
  },

  'user.read': {
    roles: EVERYONE,
    description:
      'List and read the users the caller may see, each in the shape the caller is entitled to ' +
      '(basic, contact or full).',
  },
  'user.update': {
    roles: EVERYONE,
    description:
      'Change a user: an admin any field of anyone, everyone else their own name and language.',
  },
  'user.manage': {
    roles: ADMINS,
    description:
      'Create, archive and restore users; issue activation and password-reset codes; list and ' +
      "end a user's sessions.",
  },
  'user.read_scope': {
    roles: ADMINS,
    description: "Inspect another user's resolved scope.",
  },

  'membership.read': { roles: ADMINS, description: 'List and read memberships.' },
  'membership.manage': {
    roles: ADMINS,
    description:
      "Create, change and archive memberships, never above the granter's own role or scope " +
      'and never removing the last active admin.',
  },

  'site.read': { roles: EVERYONE, description: 'List and read the sites the caller may see.' },
  'site.manage': { roles: MANAGERS_UP, description: 'Create, change, archive and restore sites.' },

  'team.read': { roles: EVERYONE, description: 'List and read the teams the caller may see.' },
  'team.manage': { roles: MANAGERS_UP, description: 'Create, change, archive and restore teams.' },

  'log_type.read': { roles: EVERYONE, description: 'List and read log types.' },
  'log_type.manage': { roles: MANAGERS_UP, description: 'Create, change and archive log types.' },

  'task.read': { roles: EVERYONE, description: 'List and read the tasks the caller may see.' },
  'task.manage': {
    roles: SUPERVISORS_UP,
    description:
      'Create, edit, assign and archive tasks: a supervisor within their scope and for their ' +
      'people, a manager or admin everywhere.',
  },
  'task.change_status': {
    roles: EVERYONE,
    description:
      'Change the status of a task: whoever manages it to any status, an assignee to todo, ' +
      'in_progress, blocked or done.',
  },

  'work_log.read': {
    roles: EVERYONE,
    description: 'List and read the work logs the caller may see.',
  },
  'work_log.create': {
    roles: EVERYONE,
    description: "Create a work log of one's own, as draft or submitted.",
  },
  'work_log.update': {
    roles: EVERYONE,
    description:
      "Edit the content of one's own work log, inside the edit window and while not approved.",
  },
  'work_log.change_status': {
    roles: EVERYONE,
    description:
      'Move a work log to another status: the author between draft and submitted; a ' +
      'supervisor or above approves, rejects and reopens, never their own log.',
  },
  'work_log.archive': {
    roles: EVERYONE,
    description:
      'Archive a work log: its author under the edit rule, or a supervisor or above who can ' +
      'see it and did not write it.',
  },

  'attachment.read': {
    roles: EVERYONE,
    description: 'List and read the attachments of the work logs the caller may see.',
  },
  'attachment.create': {
    roles: EVERYONE,
    description:
      'Upload a photo to a work log (start, renew the upload URL, complete), under the same ' +
      'rule as archiving the log.',
  },
  'attachment.archive': {
    roles: EVERYONE,
    description: 'Archive an attachment, under the same rule as archiving its work log.',
  },

  // Phase 6: the web dashboard (ADR-0009). Each reads or acts only inside the caller's
  // visibility, exactly like the lists it summarises.
  'work_log.review': {
    roles: SUPERVISORS_UP,
    description:
      'Approve or reject many work logs at once: each item under the same rule as a single ' +
      'status change (visible to the caller, never their own log), with per-item results.',
  },
  'dashboard.read': {
    roles: SUPERVISORS_UP,
    description:
      "Read the overview of the caller's scope: today's logs (in the organization's time " +
      'zone), the review queue, open, overdue and blocked tasks, activity per site and team, ' +
      'and the workers without activity.',
  },
  'directory.read': {
    roles: SUPERVISORS_UP,
    description:
      'Read the names behind ids (users in the basic shape, sites, teams, log types) for the ' +
      'records the caller may see.',
  },
  'export.work_logs': {
    roles: SUPERVISORS_UP,
    description:
      'Export the visible work logs matching the list filters as CSV (at most 10,000 rows). ' +
      'Every export is audited.',
  },
  'export.tasks': {
    roles: SUPERVISORS_UP,
    description:
      'Export the visible tasks matching the list filters as CSV (at most 10,000 rows). Every ' +
      'export is audited.',
  },
  'report.read': {
    roles: SUPERVISORS_UP,
    description:
      'Read the printable work-log report (totals and groupings) of the visible logs for a ' +
      'range of at most 92 days.',
  },

  'sync.pull': {
    roles: EVERYONE,
    description:
      "Pull the caller's offline data (assigned tasks, log types, visible sites and teams, own " +
      'recent work logs and notifications), filtered by the same visibility rules as every read.',
  },

  // Platform routes. The platform puts the decorators on them; their meaning is decided here.
  'audit.read': { roles: ADMINS, description: 'Read the audit log of the organization.' },
  'outbox.read': {
    roles: ADMINS,
    description:
      'Read the event outbox, for development and tests. The route does not exist in ' +
      'production (404).',
  },
} as const satisfies Record<string, PolicyDefinition>;

export type PolicyName = keyof typeof POLICIES;

/** Policies whose routes do not exist in production: the authorizer answers 404 there. */
export const NON_PRODUCTION_POLICIES: readonly PolicyName[] = ['outbox.read'];

export function isPolicyName(name: string): name is PolicyName {
  return Object.prototype.hasOwnProperty.call(POLICIES, name);
}

/** The definition of a policy, or undefined for a name that is not registered. */
export function findPolicy(name: string): PolicyDefinition | undefined {
  return isPolicyName(name) ? POLICIES[name] : undefined;
}

export interface PolicyEntry extends PolicyDefinition {
  name: PolicyName;
}

/** Every registered policy, in the order of the registry. */
export function listPolicies(): PolicyEntry[] {
  return (Object.keys(POLICIES) as PolicyName[]).map((name) => ({ name, ...POLICIES[name] }));
}
