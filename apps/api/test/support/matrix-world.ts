import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  createLogType,
  createMembership,
  createOrganization,
  createSite,
  createTask,
  createTeam,
  createUser,
  createWorkLog,
} from './factories';

/**
 * The deliberate fixture of the permissions tests. Names are fictional, emails use example.test.
 *
 * Organization Alpha
 *   Sites  S1 (North) ⊃ S1c (North Yard), S2 (South)
 *   Teams  T1 (Electrical) ⊃ T1c (Night shift), T2 (Plumbing)
 *
 *   wNone     worker, placed nowhere (0 sites, 0 teams)
 *   wA        worker at S1 (1 site; works at S1 and S1c)
 *   wB        worker at S1c and in T1 (1 site, 1 team; works in T1 and T1c)
 *   wC        worker at S2 and in T1c and T2 (1 site, 2 teams)
 *   wD        worker at S1c and S2 (2 sites)
 *   supS1     supervisor of the site S1 (and so of S1c)
 *   supT2     supervisor of the team T2
 *   supS2T1   supervisor of the site S2 and of the team T1 (and so of T1c)
 *   dual      worker in T2 AND supervisor of the site S1c (two memberships, different scopes)
 *   manager   manager (organization-wide)
 *   admin1    admin (organization-wide)
 *   admin2    admin (organization-wide)
 *   noMember  signed in, no membership at all
 *
 *   task1  site S1,  by supS1,   assigned to wA
 *   task2  team T2,  by manager, assigned to wC and wNone
 *   task3  site S2,  by admin1,  nobody assigned
 *   task4  no place, by admin1,  assigned to wD
 *   task5  site S1c + team T1, by supS2T1, assigned to wB
 *
 *   logA (wA, S1)  logB (wB, S1c+T1)  logC (wC, T2)  logD (wD, no place)  logNone (wNone)
 *   logSupS1 (supS1, S1)  logDual (dual, T2)  logMgr (manager, S2)  logAdmin (admin1)
 *
 * Organization Beta: adminB, workerB (same email as wA), site SB, team TB, taskB, logB2.
 */

export const VIEWERS = [
  'wNone',
  'wA',
  'wB',
  'wC',
  'wD',
  'supS1',
  'supT2',
  'supS2T1',
  'dual',
  'manager',
  'admin1',
  'admin2',
  'noMember',
] as const;
export type Viewer = (typeof VIEWERS)[number];

export const WORKERS: readonly Viewer[] = ['wNone', 'wA', 'wB', 'wC', 'wD'];
export const SUPERVISORS: readonly Viewer[] = ['supS1', 'supT2', 'supS2T1', 'dual'];
export const ORG_WIDE: readonly Viewer[] = ['manager', 'admin1', 'admin2'];
export const ADMINS: readonly Viewer[] = ['admin1', 'admin2'];

export const SITES = ['S1', 'S1c', 'S2', 'SB'] as const;
export const TEAMS = ['T1', 'T1c', 'T2', 'TB'] as const;
export const TASKS = ['task1', 'task2', 'task3', 'task4', 'task5', 'taskB'] as const;
export const LOGS = [
  'logA',
  'logB',
  'logC',
  'logD',
  'logNone',
  'logSupS1',
  'logDual',
  'logMgr',
  'logAdmin',
  'logB2',
] as const;
export const USERS = [...VIEWERS, 'adminB', 'workerB'] as const;

export type SiteName = (typeof SITES)[number];
export type TeamName = (typeof TEAMS)[number];
export type TaskName = (typeof TASKS)[number];
export type LogName = (typeof LOGS)[number];
export type UserName = (typeof USERS)[number];

/** Where a record is placed and who it belongs to, so a test can create a fresh copy of it. */
export interface LogTemplate {
  author: UserName;
  site: SiteName | null;
  team: TeamName | null;
  org: 'alpha' | 'beta';
}

export interface TaskTemplate {
  createdBy: UserName;
  site: SiteName | null;
  team: TeamName | null;
  assignees: UserName[];
  org: 'alpha' | 'beta';
}

export const LOG_TEMPLATES: Record<LogName, LogTemplate> = {
  logA: { author: 'wA', site: 'S1', team: null, org: 'alpha' },
  logB: { author: 'wB', site: 'S1c', team: 'T1', org: 'alpha' },
  logC: { author: 'wC', site: null, team: 'T2', org: 'alpha' },
  logD: { author: 'wD', site: null, team: null, org: 'alpha' },
  logNone: { author: 'wNone', site: null, team: null, org: 'alpha' },
  logSupS1: { author: 'supS1', site: 'S1', team: null, org: 'alpha' },
  logDual: { author: 'dual', site: null, team: 'T2', org: 'alpha' },
  logMgr: { author: 'manager', site: 'S2', team: null, org: 'alpha' },
  logAdmin: { author: 'admin1', site: null, team: null, org: 'alpha' },
  logB2: { author: 'workerB', site: 'SB', team: null, org: 'beta' },
};

export const TASK_TEMPLATES: Record<TaskName, TaskTemplate> = {
  task1: { createdBy: 'supS1', site: 'S1', team: null, assignees: ['wA'], org: 'alpha' },
  task2: {
    createdBy: 'manager',
    site: null,
    team: 'T2',
    assignees: ['wC', 'wNone'],
    org: 'alpha',
  },
  task3: { createdBy: 'admin1', site: 'S2', team: null, assignees: [], org: 'alpha' },
  task4: { createdBy: 'admin1', site: null, team: null, assignees: ['wD'], org: 'alpha' },
  task5: { createdBy: 'supS2T1', site: 'S1c', team: 'T1', assignees: ['wB'], org: 'alpha' },
  taskB: { createdBy: 'adminB', site: 'SB', team: null, assignees: ['workerB'], org: 'beta' },
};

export interface MatrixWorld {
  alpha: { id: string; slug: string };
  beta: { id: string; slug: string };
  users: Record<UserName, string>;
  sites: Record<SiteName, string>;
  teams: Record<TeamName, string>;
  tasks: Record<TaskName, string>;
  logs: Record<LogName, string>;
  memberships: Partial<Record<UserName, string[]>>;
  logTypeId: string;
  /** Inverse lookups for readable failure messages. */
  nameOf(id: string): string;
  orgOf(org: 'alpha' | 'beta'): string;
  /** A fresh work log placed like the template (createdAt now, status as given). */
  freshLog(name: LogName, data?: Record<string, unknown>): Promise<string>;
  /** A fresh task placed like the template. */
  freshTask(name: TaskName, data?: Record<string, unknown>): Promise<string>;
}

export async function buildMatrixWorld(prisma: PrismaService): Promise<MatrixWorld> {
  const alphaOrg = await createOrganization(prisma, { name: 'Alpha Works' });
  const betaOrg = await createOrganization(prisma, { name: 'Beta Works' });
  const a = alphaOrg.id;
  const b = betaOrg.id;

  const s1 = await createSite(prisma, a, { name: 'North' });
  const s1c = await createSite(prisma, a, { name: 'North Yard', parentId: s1.id });
  const s2 = await createSite(prisma, a, { name: 'South' });
  const sb = await createSite(prisma, b, { name: 'Beta Site' });
  const t1 = await createTeam(prisma, a, { name: 'Electrical' });
  const t1c = await createTeam(prisma, a, { name: 'Night shift', parentId: t1.id });
  const t2 = await createTeam(prisma, a, { name: 'Plumbing' });
  const tb = await createTeam(prisma, b, { name: 'Beta Team' });
  const sites: Record<SiteName, string> = { S1: s1.id, S1c: s1c.id, S2: s2.id, SB: sb.id };
  const teams: Record<TeamName, string> = { T1: t1.id, T1c: t1c.id, T2: t2.id, TB: tb.id };

  const users = {} as Record<UserName, string>;
  const make = async (name: UserName, org: string, email: string) => {
    const user = await createUser(prisma, org, {
      email,
      displayName: `Person ${name}`,
      phone: `+9055500${String(Object.keys(users).length).padStart(5, '0')}`,
    });
    users[name] = user.id;
  };
  for (const name of VIEWERS) {
    await make(name, a, `${name.toLowerCase()}@alpha.example.test`);
  }
  await make('adminB', b, 'adminb@beta.example.test');
  // The same email as wA, in the other organization.
  await make('workerB', b, 'wa@alpha.example.test');

  const memberships: Partial<Record<UserName, string[]>> = {};
  const member = async (
    name: UserName,
    role: 'worker' | 'supervisor' | 'manager' | 'admin',
    scope: { orgWide?: boolean; siteIds?: string[]; teamIds?: string[] } = {},
    org = a,
  ) => {
    const membership = await createMembership(prisma, org, users[name], role, scope);
    memberships[name] = [...(memberships[name] ?? []), membership.id];
  };
  await member('wNone', 'worker');
  await member('wA', 'worker', { siteIds: [s1.id] });
  await member('wB', 'worker', { siteIds: [s1c.id], teamIds: [t1.id] });
  await member('wC', 'worker', { siteIds: [s2.id], teamIds: [t1c.id, t2.id] });
  await member('wD', 'worker', { siteIds: [s1c.id, s2.id] });
  await member('supS1', 'supervisor', { siteIds: [s1.id] });
  await member('supT2', 'supervisor', { teamIds: [t2.id] });
  await member('supS2T1', 'supervisor', { siteIds: [s2.id], teamIds: [t1.id] });
  await member('dual', 'worker', { teamIds: [t2.id] });
  await member('dual', 'supervisor', { siteIds: [s1c.id] });
  await member('manager', 'manager', { orgWide: true });
  await member('admin1', 'admin', { orgWide: true });
  await member('admin2', 'admin', { orgWide: true });
  await member('adminB', 'admin', { orgWide: true }, b);
  await member('workerB', 'worker', { siteIds: [sb.id] }, b);

  const logType = await createLogType(prisma, a, { fields: [] });

  const orgOf = (org: 'alpha' | 'beta') => (org === 'alpha' ? a : b);

  const freshTask = async (name: TaskName, data: Record<string, unknown> = {}) => {
    const template = TASK_TEMPLATES[name];
    const task = await createTask(prisma, orgOf(template.org), users[template.createdBy], {
      siteId: template.site ? sites[template.site] : null,
      teamId: template.team ? teams[template.team] : null,
      assigneeIds: template.assignees.map((assignee) => users[assignee]),
      title: `Copy of ${name}`,
      ...data,
    });
    return task.id;
  };
  const freshLog = async (name: LogName, data: Record<string, unknown> = {}) => {
    const template = LOG_TEMPLATES[name];
    const log = await createWorkLog(prisma, orgOf(template.org), users[template.author], {
      siteId: template.site ? sites[template.site] : null,
      teamId: template.team ? teams[template.team] : null,
      text: `Copy of ${name}`,
      ...data,
    });
    return log.id;
  };

  const tasks = {} as Record<TaskName, string>;
  for (const name of TASKS) {
    tasks[name] = await freshTask(name, { title: `Task ${name}` });
  }
  const logs = {} as Record<LogName, string>;
  for (const name of LOGS) {
    logs[name] = await freshLog(name, { text: `Log ${name}` });
  }

  const names = new Map<string, string>();
  for (const table of [users, sites, teams, tasks, logs]) {
    for (const [name, id] of Object.entries(table)) {
      names.set(id, name);
    }
  }

  return {
    alpha: { id: a, slug: alphaOrg.slug },
    beta: { id: b, slug: betaOrg.slug },
    users,
    sites,
    teams,
    tasks,
    logs,
    memberships,
    logTypeId: logType.id,
    nameOf: (id) => names.get(id) ?? id,
    orgOf,
    freshLog,
    freshTask,
  };
}

// ---------------------------------------------------------------------------------------------
// What each viewer may see, written out by hand from the rules (ARCHITECTURE.md / the brief), so
// the tests compare the API against the rules and not against the implementation.
// ---------------------------------------------------------------------------------------------

const ALL_ALPHA_LOGS: LogName[] = LOGS.filter((name) => LOG_TEMPLATES[name].org === 'alpha');
const ALL_ALPHA_TASKS: TaskName[] = TASKS.filter((name) => TASK_TEMPLATES[name].org === 'alpha');
const ALL_ALPHA_SITES: SiteName[] = ['S1', 'S1c', 'S2'];
const ALL_ALPHA_TEAMS: TeamName[] = ['T1', 'T1c', 'T2'];
const ALL_ALPHA_USERS: UserName[] = [...VIEWERS];

/** Work logs: a worker their own; a supervisor their scope and their people; managers all. */
export const VISIBLE_LOGS: Record<Viewer, LogName[]> = {
  wNone: ['logNone'],
  wA: ['logA'],
  wB: ['logB'],
  wC: ['logC'],
  wD: ['logD'],
  // S1, S1c; people wA, wB, wD, dual.
  supS1: ['logA', 'logB', 'logD', 'logSupS1', 'logDual'],
  // T2; people wC, dual.
  supT2: ['logC', 'logDual'],
  // S2, T1, T1c; people wB, wC, wD.
  supS2T1: ['logB', 'logC', 'logD', 'logMgr'],
  // S1c; people wA, wB, wD (as a worker in T2 they see only their own).
  dual: ['logA', 'logB', 'logD', 'logDual'],
  manager: ALL_ALPHA_LOGS,
  admin1: ALL_ALPHA_LOGS,
  admin2: ALL_ALPHA_LOGS,
  noMember: [],
};

/** Tasks: a worker those assigned to them; a supervisor scope, people's tasks, created ones. */
export const VISIBLE_TASKS: Record<Viewer, TaskName[]> = {
  wNone: ['task2'],
  wA: ['task1'],
  wB: ['task5'],
  wC: ['task2'],
  wD: ['task4'],
  supS1: ['task1', 'task4', 'task5'],
  supT2: ['task2'],
  supS2T1: ['task2', 'task3', 'task4', 'task5'],
  dual: ['task1', 'task4', 'task5'],
  manager: ALL_ALPHA_TASKS,
  admin1: ALL_ALPHA_TASKS,
  admin2: ALL_ALPHA_TASKS,
  noMember: [],
};

/** Sites: where they belong (with descendants), their scope, and the sites of their tasks. */
export const VISIBLE_SITES: Record<Viewer, SiteName[]> = {
  wNone: [],
  wA: ['S1', 'S1c'],
  wB: ['S1c'],
  wC: ['S2'],
  wD: ['S1c', 'S2'],
  supS1: ['S1', 'S1c'],
  supT2: [],
  supS2T1: ['S2'],
  dual: ['S1c'],
  manager: ALL_ALPHA_SITES,
  admin1: ALL_ALPHA_SITES,
  admin2: ALL_ALPHA_SITES,
  noMember: [],
};

export const VISIBLE_TEAMS: Record<Viewer, TeamName[]> = {
  // T2 through task2, assigned to them.
  wNone: ['T2'],
  wA: [],
  wB: ['T1', 'T1c'],
  wC: ['T1c', 'T2'],
  wD: [],
  supS1: [],
  supT2: ['T2'],
  supS2T1: ['T1', 'T1c'],
  dual: ['T2'],
  manager: ALL_ALPHA_TEAMS,
  admin1: ALL_ALPHA_TEAMS,
  admin2: ALL_ALPHA_TEAMS,
  noMember: [],
};

export type ProfileLevel = 'basic' | 'contact' | 'full';

/**
 * Users, and the shape each is returned in. Everyone sees themselves in full. A worker sees
 * colleagues (same site or team, with descendants, and the supervisors there) and task peers
 * (co-assignees, creators) in the basic shape; a supervisor sees their people with contact
 * details; a manager everyone with contact details; an admin everyone in full.
 */
export const VISIBLE_USERS: Record<Viewer, Partial<Record<UserName, ProfileLevel>>> = {
  // task2: co-assignee wC, creator manager.
  wNone: { wNone: 'full', wC: 'basic', manager: 'basic' },
  // Works at S1, S1c with wB, wD; supervisors there supS1, dual. task1 by supS1.
  wA: { wA: 'full', wB: 'basic', wD: 'basic', supS1: 'basic', dual: 'basic' },
  wB: {
    wB: 'full',
    wA: 'basic',
    wC: 'basic',
    wD: 'basic',
    supS1: 'basic',
    supS2T1: 'basic',
    dual: 'basic',
  },
  wC: {
    wC: 'full',
    wB: 'basic',
    wD: 'basic',
    supT2: 'basic',
    supS2T1: 'basic',
    dual: 'basic',
    wNone: 'basic',
    manager: 'basic',
  },
  // task4 was created by admin1.
  wD: {
    wD: 'full',
    wA: 'basic',
    wB: 'basic',
    wC: 'basic',
    supS1: 'basic',
    supS2T1: 'basic',
    dual: 'basic',
    admin1: 'basic',
  },
  supS1: { supS1: 'full', wA: 'contact', wB: 'contact', wD: 'contact', dual: 'contact' },
  supT2: { supT2: 'full', wC: 'contact', dual: 'contact' },
  supS2T1: { supS2T1: 'full', wB: 'contact', wC: 'contact', wD: 'contact' },
  // People wA, wB, wD as a supervisor; colleagues wC, supT2 in T2 as a worker.
  dual: {
    dual: 'full',
    wA: 'contact',
    wB: 'contact',
    wD: 'contact',
    wC: 'basic',
    supT2: 'basic',
  },
  manager: Object.fromEntries(
    ALL_ALPHA_USERS.map((name) => [name, name === 'manager' ? 'full' : 'contact']),
  ),
  admin1: Object.fromEntries(ALL_ALPHA_USERS.map((name) => [name, 'full'])),
  admin2: Object.fromEntries(ALL_ALPHA_USERS.map((name) => [name, 'full'])),
  noMember: {},
};

/** Supervisors may manage (create, edit, assign, archive) a task placed in their scope. */
export const SUPERVISOR_SCOPE: Record<string, { sites: SiteName[]; teams: TeamName[] }> = {
  supS1: { sites: ['S1', 'S1c'], teams: [] },
  supT2: { sites: [], teams: ['T2'] },
  supS2T1: { sites: ['S2'], teams: ['T1', 'T1c'] },
  dual: { sites: ['S1c'], teams: [] },
};
