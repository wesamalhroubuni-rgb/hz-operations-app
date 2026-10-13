import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import {
  createLogTypeSchema,
  createMembershipSchema,
  createTaskSchema,
  createWorkLogSchema,
  type CreateLogTypeInput,
  type Role,
  type TaskPriority,
  type TaskStatus,
  type WorkLogStatus,
} from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ChangeRecorder } from '../common/change-recorder';
import { LogTypesService } from '../log-types/log-types.service';
import { MembershipsService } from '../memberships/memberships.service';
import { toOrganization } from '../organization/organization.service';
import { SitesService } from '../sites/sites.service';
import { TasksService } from '../tasks/tasks.service';
import { TeamsService } from '../teams/teams.service';
import { UsersService } from '../users/users.service';
import { WorkLogsService } from '../work-logs/work-logs.service';

/**
 * Demo data for development: one organization with sites, teams, people in every role, three
 * log types, and two weeks of tasks and work logs. Everything except the organization row is
 * created through the domain services, so validation runs and audit and outbox rows are written
 * by the real code path (attributed to the system, because there is no request).
 *
 * All names are invented and all emails use example.com.
 */

export const DEMO_ORGANIZATION = { name: 'HZ Demo', slug: 'hz-demo' } as const;

type SiteKey = 'depot' | 'harbour';
type TeamKey = 'electrical' | 'maintenance' | 'logistics';
type LogTypeKey = 'inspection' | 'delivery' | 'material_usage';
type UserKey =
  | 'admin'
  | 'manager'
  | 'depotSupervisor'
  | 'harbourSupervisor'
  | 'deniz'
  | 'can'
  | 'zeynep'
  | 'burak'
  | 'elif'
  | 'kerem';

const SITES: Record<
  SiteKey,
  { name: string; code: string; address: string; lat: number; lng: number }
> = {
  depot: {
    name: 'North Depot',
    code: 'HZ-N',
    address: '12 Depot Road, North District',
    lat: 41.0512,
    lng: 28.9871,
  },
  harbour: {
    name: 'Harbour Project',
    code: 'HZ-H',
    address: 'Pier 4, Harbour Zone',
    lat: 40.9893,
    lng: 28.8317,
  },
};

const TEAMS: Record<TeamKey, { name: string; description: string }> = {
  electrical: { name: 'Electrical', description: 'Wiring, panels and lighting' },
  maintenance: { name: 'Maintenance', description: 'Repairs and routine checks' },
  logistics: { name: 'Logistics', description: 'Deliveries, stock and transport' },
};

interface DemoMembership {
  role: Role;
  orgWide?: boolean;
  sites?: SiteKey[];
  teams?: TeamKey[];
}

const USERS: Record<UserKey, { name: string; email: string; memberships: DemoMembership[] }> = {
  admin: {
    name: 'Aylin Demir',
    email: 'aylin.demir@example.com',
    memberships: [{ role: 'admin', orgWide: true }],
  },
  manager: {
    name: 'Murat Kaya',
    email: 'murat.kaya@example.com',
    memberships: [{ role: 'manager', orgWide: true }],
  },
  // Supervisor scoped to one site.
  depotSupervisor: {
    name: 'Selin Aydin',
    email: 'selin.aydin@example.com',
    memberships: [{ role: 'supervisor', sites: ['depot'] }],
  },
  // Supervisor scoped to a site AND a team (a union).
  harbourSupervisor: {
    name: 'Emre Sahin',
    email: 'emre.sahin@example.com',
    memberships: [{ role: 'supervisor', sites: ['harbour'], teams: ['logistics'] }],
  },
  // Worker in two teams.
  deniz: {
    name: 'Deniz Yilmaz',
    email: 'deniz.yilmaz@example.com',
    memberships: [{ role: 'worker', teams: ['electrical', 'maintenance'] }],
  },
  can: {
    name: 'Can Ozturk',
    email: 'can.ozturk@example.com',
    memberships: [{ role: 'worker', sites: ['depot'], teams: ['electrical'] }],
  },
  zeynep: {
    name: 'Zeynep Arslan',
    email: 'zeynep.arslan@example.com',
    memberships: [{ role: 'worker', sites: ['depot'], teams: ['maintenance'] }],
  },
  burak: {
    name: 'Burak Celik',
    email: 'burak.celik@example.com',
    memberships: [{ role: 'worker', sites: ['harbour'], teams: ['logistics'] }],
  },
  elif: {
    name: 'Elif Dogan',
    email: 'elif.dogan@example.com',
    memberships: [{ role: 'worker', teams: ['logistics'] }],
  },
  kerem: {
    name: 'Kerem Polat',
    email: 'kerem.polat@example.com',
    memberships: [{ role: 'worker', sites: ['harbour'], teams: ['maintenance'] }],
  },
};

/** Between them the three log types use every custom field type. */
const LOG_TYPES: Record<LogTypeKey, CreateLogTypeInput> = {
  inspection: {
    key: 'inspection',
    name: 'Inspection',
    description: 'A safety or quality check of an area or a piece of equipment',
    fields: [
      { key: 'area', label: 'Area inspected', type: 'text', required: true },
      {
        key: 'result',
        label: 'Result',
        type: 'select',
        required: true,
        options: ['pass', 'fail', 'needs follow-up'],
      },
      { key: 'issues_found', label: 'Issues found', type: 'number' },
      {
        key: 'follow_up_date',
        label: 'Follow-up date',
        type: 'date',
        helpText: 'Only when the result needs a follow-up',
      },
    ],
  },
  delivery: {
    key: 'delivery',
    name: 'Delivery',
    description: 'Goods received at a site',
    fields: [
      { key: 'supplier', label: 'Supplier', type: 'text', required: true },
      { key: 'packages', label: 'Number of packages', type: 'number', required: true },
      { key: 'damaged', label: 'Any damage?', type: 'boolean', required: true },
      { key: 'received_on', label: 'Received on', type: 'date' },
    ],
  },
  material_usage: {
    key: 'material_usage',
    name: 'Material usage',
    description: 'Materials used for a job',
    fields: [
      {
        key: 'material',
        label: 'Material',
        type: 'select',
        required: true,
        options: ['cable', 'conduit', 'cement', 'paint', 'fasteners'],
      },
      { key: 'quantity', label: 'Quantity', type: 'number', required: true },
      {
        key: 'unit',
        label: 'Unit',
        type: 'select',
        required: true,
        options: ['m', 'kg', 'l', 'pcs'],
      },
      { key: 'leftover_returned', label: 'Leftover returned to stock', type: 'boolean' },
    ],
  },
};

interface DemoTask {
  title: string;
  description?: string;
  createdBy: UserKey;
  status: TaskStatus;
  priority: TaskPriority;
  site?: SiteKey;
  team?: TeamKey;
  assignees: UserKey[];
  /** Due date in days from today (negative = in the past). */
  dueInDays?: number;
}

const TASKS: DemoTask[] = [
  {
    title: 'Replace lighting in bay 3',
    description: 'Swap the old fittings for LED panels.',
    createdBy: 'depotSupervisor',
    status: 'done',
    priority: 'normal',
    site: 'depot',
    team: 'electrical',
    assignees: ['can', 'deniz'],
    dueInDays: -6,
  },
  {
    title: 'Monthly fire extinguisher check',
    createdBy: 'depotSupervisor',
    status: 'in_progress',
    priority: 'high',
    site: 'depot',
    team: 'maintenance',
    assignees: ['zeynep'],
    dueInDays: 2,
  },
  {
    title: 'Receive steel delivery for pier 4',
    createdBy: 'harbourSupervisor',
    status: 'done',
    priority: 'high',
    site: 'harbour',
    team: 'logistics',
    assignees: ['burak', 'elif'],
    dueInDays: -9,
  },
  {
    title: 'Repair loading ramp hydraulics',
    description: 'Ramp 2 sinks under load. Waiting for the replacement seal kit.',
    createdBy: 'harbourSupervisor',
    status: 'blocked',
    priority: 'urgent',
    site: 'harbour',
    team: 'maintenance',
    assignees: ['kerem'],
    dueInDays: 1,
  },
  {
    title: 'Stock count: cable and conduit',
    createdBy: 'manager',
    status: 'todo',
    priority: 'normal',
    team: 'logistics',
    assignees: ['elif'],
    dueInDays: 5,
  },
  {
    title: 'Install temporary site power',
    createdBy: 'manager',
    status: 'in_progress',
    priority: 'high',
    site: 'harbour',
    team: 'electrical',
    assignees: ['deniz'],
    dueInDays: 3,
  },
  {
    title: 'Repaint safety markings',
    createdBy: 'depotSupervisor',
    status: 'todo',
    priority: 'low',
    site: 'depot',
    assignees: [],
    dueInDays: 10,
  },
  {
    title: 'Survey old storage shed',
    description: 'Cancelled: the shed is being demolished.',
    createdBy: 'admin',
    status: 'cancelled',
    priority: 'low',
    site: 'depot',
    assignees: ['zeynep'],
  },
];

interface DemoWorkLog {
  daysAgo: number;
  hour: number;
  author: UserKey;
  site?: SiteKey;
  team?: TeamKey;
  /** Index into TASKS. */
  task?: number;
  logType?: LogTypeKey;
  customFields?: Record<string, string | number | boolean>;
  text?: string;
  /** Attach a GPS position near the site. */
  gps?: boolean;
  /** Final status. Defaults to `submitted`. */
  status?: WorkLogStatus;
}

const WORK_LOGS: DemoWorkLog[] = [
  {
    daysAgo: 13,
    hour: 8,
    author: 'can',
    site: 'depot',
    team: 'electrical',
    task: 0,
    text: 'Isolated the bay 3 circuit and removed the first six fittings.',
    gps: true,
    status: 'approved',
  },
  {
    daysAgo: 13,
    hour: 14,
    author: 'burak',
    site: 'harbour',
    team: 'logistics',
    logType: 'delivery',
    customFields: { supplier: 'Marmara Timber', packages: 14, damaged: false },
    text: 'Formwork timber, stacked by gate B.',
    gps: true,
    status: 'approved',
  },
  {
    daysAgo: 12,
    hour: 9,
    author: 'deniz',
    site: 'depot',
    team: 'electrical',
    task: 0,
    logType: 'material_usage',
    customFields: { material: 'cable', quantity: 85, unit: 'm', leftover_returned: true },
    status: 'approved',
  },
  {
    daysAgo: 12,
    hour: 11,
    author: 'zeynep',
    site: 'depot',
    team: 'maintenance',
    logType: 'inspection',
    customFields: { area: 'Workshop compressors', result: 'pass', issues_found: 0 },
    status: 'approved',
  },
  {
    daysAgo: 11,
    hour: 7,
    author: 'kerem',
    site: 'harbour',
    team: 'maintenance',
    task: 3,
    text: 'Ramp 2 loses pressure after about ten minutes under load. Seal looks worn.',
    gps: true,
    status: 'approved',
  },
  {
    daysAgo: 10,
    hour: 10,
    author: 'burak',
    site: 'harbour',
    team: 'logistics',
    task: 2,
    logType: 'delivery',
    customFields: { supplier: 'Anadolu Steel', packages: 32, damaged: true },
    text: 'Two bundles arrived with bent ends; photos to follow.',
    gps: true,
    status: 'approved',
  },
  {
    daysAgo: 10,
    hour: 15,
    author: 'elif',
    team: 'logistics',
    task: 2,
    text: 'Checked the delivery note against the order. Quantities match.',
    status: 'approved',
  },
  {
    daysAgo: 9,
    hour: 9,
    author: 'can',
    site: 'depot',
    team: 'electrical',
    task: 0,
    logType: 'material_usage',
    customFields: { material: 'fasteners', quantity: 120, unit: 'pcs' },
    status: 'approved',
  },
  {
    daysAgo: 8,
    hour: 13,
    author: 'deniz',
    site: 'depot',
    team: 'electrical',
    task: 0,
    text: 'All LED panels fitted and tested. Bay 3 is back in use.',
    gps: true,
    status: 'approved',
  },
  {
    daysAgo: 8,
    hour: 16,
    author: 'zeynep',
    site: 'depot',
    team: 'maintenance',
    logType: 'inspection',
    customFields: { area: 'Emergency exits, building A', result: 'fail', issues_found: 2 },
    text: 'Exit 2 was blocked by pallets and its sign is not lit.',
    status: 'approved',
  },
  {
    daysAgo: 7,
    hour: 8,
    author: 'kerem',
    site: 'harbour',
    team: 'maintenance',
    logType: 'material_usage',
    customFields: { material: 'paint', quantity: 12, unit: 'l', leftover_returned: false },
    text: 'Anti-rust coat on the pier railings.',
    status: 'approved',
  },
  {
    daysAgo: 6,
    hour: 10,
    author: 'burak',
    site: 'harbour',
    team: 'logistics',
    logType: 'delivery',
    customFields: { supplier: 'Bosphorus Electric', packages: 6, damaged: false },
    gps: true,
    status: 'approved',
  },
  {
    daysAgo: 6,
    hour: 14,
    author: 'deniz',
    site: 'harbour',
    team: 'electrical',
    task: 5,
    text: 'Set the temporary distribution board and earthing rod.',
    gps: true,
  },
  {
    daysAgo: 5,
    hour: 9,
    author: 'zeynep',
    site: 'depot',
    team: 'maintenance',
    task: 1,
    logType: 'inspection',
    customFields: { area: 'Fire extinguishers, building A', result: 'pass', issues_found: 0 },
    gps: true,
  },
  {
    daysAgo: 5,
    hour: 11,
    author: 'elif',
    team: 'logistics',
    text: 'Reorganised the small-parts shelves in the store.',
    status: 'rejected',
  },
  {
    daysAgo: 4,
    hour: 8,
    author: 'can',
    site: 'depot',
    team: 'electrical',
    logType: 'inspection',
    customFields: { area: 'Main switch room', result: 'needs follow-up', issues_found: 1 },
    text: 'One breaker runs warm; recheck after the load test.',
  },
  {
    daysAgo: 4,
    hour: 13,
    author: 'deniz',
    site: 'harbour',
    team: 'electrical',
    task: 5,
    logType: 'material_usage',
    customFields: { material: 'conduit', quantity: 40, unit: 'm', leftover_returned: true },
  },
  {
    daysAgo: 3,
    hour: 9,
    author: 'kerem',
    site: 'harbour',
    team: 'maintenance',
    task: 3,
    text: 'Seal kit is still not here. Ramp 2 stays out of service.',
    gps: true,
  },
  {
    daysAgo: 3,
    hour: 15,
    author: 'burak',
    site: 'harbour',
    team: 'logistics',
    logType: 'delivery',
    customFields: { supplier: 'Marmara Timber', packages: 9, damaged: false },
  },
  {
    daysAgo: 2,
    hour: 10,
    author: 'zeynep',
    site: 'depot',
    team: 'maintenance',
    task: 1,
    logType: 'inspection',
    customFields: { area: 'Fire extinguishers, building B', result: 'fail', issues_found: 3 },
    text: 'Three units are past their service date.',
    gps: true,
  },
  {
    daysAgo: 2,
    hour: 14,
    author: 'elif',
    team: 'logistics',
    logType: 'material_usage',
    customFields: { material: 'cement', quantity: 250, unit: 'kg' },
    text: 'Issued to the harbour crew.',
  },
  {
    daysAgo: 1,
    hour: 8,
    author: 'can',
    site: 'depot',
    team: 'electrical',
    text: 'Replaced two faulty sockets in the canteen.',
    gps: true,
  },
  {
    daysAgo: 1,
    hour: 12,
    author: 'deniz',
    site: 'depot',
    team: 'maintenance',
    text: 'Helped the maintenance team move the spare generator.',
  },
  {
    daysAgo: 1,
    hour: 16,
    author: 'kerem',
    site: 'harbour',
    team: 'maintenance',
    logType: 'inspection',
    customFields: { area: 'Pier railings', result: 'pass' },
    status: 'draft',
  },
  {
    daysAgo: 0,
    hour: 7,
    author: 'burak',
    site: 'harbour',
    team: 'logistics',
    text: 'Gate B cleared for the morning deliveries.',
    gps: true,
    status: 'draft',
  },
];

export interface SeededUser {
  id: string;
  name: string;
  email: string;
  roles: string;
}

export interface DemoSeedResult {
  /** False when the demo organization already existed and nothing was changed. */
  seeded: boolean;
  organizationId: string;
  users: SeededUser[];
  counts: Record<string, number>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A moment `daysAgo` days back at the given UTC hour, never later than a minute ago. */
function pastMoment(now: Date, daysAgo: number, hour: number): Date {
  const day = new Date(now.getTime() - daysAgo * DAY_MS);
  day.setUTCHours(hour, 15, 0, 0);
  return new Date(Math.min(day.getTime(), now.getTime() - 60_000));
}

function describeMembership(membership: DemoMembership): string {
  const scope = [
    ...(membership.orgWide ? ['whole organization'] : []),
    ...(membership.sites ?? []).map((site) => `site ${SITES[site].name}`),
    ...(membership.teams ?? []).map((team) => `team ${TEAMS[team].name}`),
  ];
  return `${membership.role} (${scope.join(' + ') || 'no scope'})`;
}

/**
 * Creates the demo organization and its data. Idempotent: when an organization with the demo
 * slug exists, nothing is written.
 */
export async function seedDemo(app: INestApplicationContext): Promise<DemoSeedResult> {
  const prisma = app.get(PrismaService);
  const changes = app.get(ChangeRecorder);
  const sitesService = app.get(SitesService);
  const teamsService = app.get(TeamsService);
  const usersService = app.get(UsersService);
  const membershipsService = app.get(MembershipsService);
  const logTypesService = app.get(LogTypesService);
  const tasksService = app.get(TasksService);
  const workLogsService = app.get(WorkLogsService);

  const existing = await prisma.organization.findUnique({
    where: { slug: DEMO_ORGANIZATION.slug },
  });
  if (existing) {
    return { seeded: false, organizationId: existing.id, users: [], counts: {} };
  }

  // No endpoint creates organizations, so this one row is written directly (still audited).
  const organizationId = await prisma.$transaction(async (tx) => {
    const organization = toOrganization(
      await tx.organization.create({
        data: { ...DEMO_ORGANIZATION, settings: { timeZone: 'Europe/Istanbul', locale: 'en' } },
      }),
    );
    await changes.record(tx, {
      organizationId: organization.id,
      entityType: 'organization',
      verb: 'created',
      entityId: organization.id,
      after: organization,
    });
    return organization.id;
  });

  const siteIds = {} as Record<SiteKey, string>;
  for (const key of Object.keys(SITES) as SiteKey[]) {
    const { lat, lng, ...site } = SITES[key];
    siteIds[key] = (
      await sitesService.create(organizationId, { ...site, latitude: lat, longitude: lng })
    ).id;
  }

  const teamIds = {} as Record<TeamKey, string>;
  for (const key of Object.keys(TEAMS) as TeamKey[]) {
    teamIds[key] = (await teamsService.create(organizationId, TEAMS[key])).id;
  }

  const userIds = {} as Record<UserKey, string>;
  const users: SeededUser[] = [];
  let membershipCount = 0;
  for (const key of Object.keys(USERS) as UserKey[]) {
    const demo = USERS[key];
    const user = await usersService.create(organizationId, {
      email: demo.email,
      displayName: demo.name,
    });
    userIds[key] = user.id;
    for (const membership of demo.memberships) {
      await membershipsService.create(
        organizationId,
        createMembershipSchema.parse({
          userId: user.id,
          role: membership.role,
          orgWide: membership.orgWide ?? false,
          siteIds: (membership.sites ?? []).map((site) => siteIds[site]),
          teamIds: (membership.teams ?? []).map((team) => teamIds[team]),
        }),
      );
      membershipCount += 1;
    }
    users.push({
      id: user.id,
      name: demo.name,
      email: demo.email,
      roles: demo.memberships.map(describeMembership).join('; '),
    });
  }

  const logTypeIds = {} as Record<LogTypeKey, string>;
  for (const key of Object.keys(LOG_TYPES) as LogTypeKey[]) {
    logTypeIds[key] = (
      await logTypesService.create(organizationId, createLogTypeSchema.parse(LOG_TYPES[key]))
    ).id;
  }

  const now = new Date();
  const taskIds: string[] = [];
  for (const demo of TASKS) {
    const task = await tasksService.create(
      organizationId,
      userIds[demo.createdBy],
      createTaskSchema.parse({
        title: demo.title,
        description: demo.description,
        priority: demo.priority,
        siteId: demo.site ? siteIds[demo.site] : undefined,
        teamId: demo.team ? teamIds[demo.team] : undefined,
        assigneeIds: demo.assignees.map((assignee) => userIds[assignee]),
        dueAt:
          demo.dueInDays === undefined
            ? undefined
            : new Date(now.getTime() + demo.dueInDays * DAY_MS).toISOString(),
      }),
    );
    taskIds.push(task.id);
  }

  for (const demo of WORK_LOGS) {
    const site = demo.site ? SITES[demo.site] : undefined;
    const { workLog } = await workLogsService.create(
      organizationId,
      userIds[demo.author],
      createWorkLogSchema.parse({
        clientId: randomUUID(),
        occurredAt: pastMoment(now, demo.daysAgo, demo.hour).toISOString(),
        taskId: demo.task === undefined ? undefined : taskIds[demo.task],
        siteId: demo.site ? siteIds[demo.site] : undefined,
        teamId: demo.team ? teamIds[demo.team] : undefined,
        logTypeId: demo.logType ? logTypeIds[demo.logType] : undefined,
        customFields: demo.customFields ?? {},
        text: demo.text,
        location:
          demo.gps && site
            ? {
                latitude: site.lat + (demo.hour - 12) * 0.0001,
                longitude: site.lng + demo.daysAgo * 0.0001,
                accuracy: 5 + demo.hour,
              }
            : undefined,
        status: demo.status === 'draft' ? 'draft' : 'submitted',
      }),
    );
    if (demo.status === 'approved' || demo.status === 'rejected') {
      await workLogsService.changeStatus(organizationId, workLog.id, demo.status);
    }
  }

  // Tasks reach their status last, through the same path a user takes, so the outbox holds
  // `task.status_changed` events after the work logs that led to them.
  for (const [index, demo] of TASKS.entries()) {
    const taskId = taskIds[index];
    if (taskId && demo.status !== 'todo') {
      await tasksService.changeStatus(organizationId, taskId, demo.status);
    }
  }

  return {
    seeded: true,
    organizationId,
    users,
    counts: {
      sites: Object.keys(SITES).length,
      teams: Object.keys(TEAMS).length,
      users: users.length,
      memberships: membershipCount,
      logTypes: Object.keys(LOG_TYPES).length,
      tasks: TASKS.length,
      workLogs: WORK_LOGS.length,
    },
  };
}
