import { randomUUID } from 'node:crypto';
import { taskSchema, userSchema } from '@ops/shared';
import { AuditService } from '../src/platform/audit/audit.service';
import {
  at,
  createLogType,
  createMembership,
  createSite,
  createTeam,
  createUser,
} from './support/factories';
import {
  ADMINS,
  buildMatrixWorld,
  LOG_TEMPLATES,
  LOGS,
  ORG_WIDE,
  SITES,
  SUPERVISOR_SCOPE,
  SUPERVISORS,
  TASK_TEMPLATES,
  TASKS,
  TEAMS,
  USERS,
  VIEWERS,
  VISIBLE_LOGS,
  VISIBLE_SITES,
  VISIBLE_TASKS,
  VISIBLE_TEAMS,
  VISIBLE_USERS,
  WORKERS,
  type LogName,
  type MatrixWorld,
  type SiteName,
  type TaskName,
  type TeamName,
  type UserName,
  type Viewer,
} from './support/matrix-world';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// Every cell of the permissions matrix, over real HTTP with real sessions, for every role and
// scope of the fixture in ./support/matrix-world.ts. Each test compares a whole row (one viewer,
// one action, every record) against the expected statuses, so a failure lists every wrong cell.
//
// 404 = outside the caller's visibility (the same as missing); 403 = visible but not allowed,
// or the role may not use the route; 409 = the state forbids it; 422 = a body reference the
// caller cannot see. A signed-in user without any membership gets 403 on every @Policy route.

const BASIC_KEYS = ['displayName', 'id', 'profile', 'roles'];
const CONTACT_KEYS = [...BASIC_KEYS, 'email', 'phone'].sort();
const FULL_KEYS = [
  ...CONTACT_KEYS,
  'activated',
  'archivedAt',
  'createdAt',
  'memberships',
  'organizationId',
  'updatedAt',
  'username',
].sort();
const KEYS_OF_LEVEL = { basic: BASIC_KEYS, contact: CONTACT_KEYS, full: FULL_KEYS };

const isSupervisorOrAbove = (viewer: Viewer) =>
  SUPERVISORS.includes(viewer) || ORG_WIDE.includes(viewer);

/** Runs one call per name, in order, and returns the statuses by name. */
async function row<Name extends string>(
  names: readonly Name[],
  call: (name: Name) => Promise<number>,
): Promise<Record<Name, number>> {
  const result = {} as Record<Name, number>;
  for (const name of names) {
    result[name] = await call(name);
  }
  return result;
}

function expected<Name extends string>(
  names: readonly Name[],
  decide: (name: Name) => number,
): Record<Name, number> {
  return Object.fromEntries(names.map((name) => [name, decide(name)])) as Record<Name, number>;
}

describe('permissions matrix: who sees what', () => {
  let ctx: TestApp;
  let w: MatrixWorld;
  let auditEventId: string;
  const api = (viewer: Viewer): ApiCaller => ctx.as(w.users[viewer]);

  beforeAll(async () => {
    ctx = await startTestApp();
    await ctx.reset();
    w = await buildMatrixWorld(ctx.prisma);
    // One audit event of Alpha to read by id.
    await ctx.app.get(AuditService).record(ctx.prisma, {
      organizationId: w.alpha.id,
      action: 'site.updated',
      entityType: 'site',
      entityId: w.sites.S1,
      after: { name: 'North' },
    });
    auditEventId = (await ctx.prisma.auditEvent.findFirstOrThrow()).id;
  });
  afterAll(() => ctx.close());

  const namesOf = (response: { body: Json }) =>
    (response.body.items as Json[]).map((item) => w.nameOf(item.id as string)).sort();

  describe('work logs', () => {
    it.each(VIEWERS)('GET /work-logs as %s lists exactly the visible logs', async (viewer) => {
      const response = await api(viewer).get('/work-logs', { pageSize: 100 });
      if (viewer === 'noMember') {
        expect(response.status).toBe(403);
        return;
      }
      expect(response.status).toBe(200);
      expect(namesOf(response)).toEqual([...VISIBLE_LOGS[viewer]].sort());
      expect(response.body.total).toBe(VISIBLE_LOGS[viewer].length);
    });

    it.each(VIEWERS)('GET /work-logs/:id as %s: 200 if visible, else 404', async (viewer) => {
      const actual = await row(
        LOGS,
        async (name) => (await api(viewer).get(`/work-logs/${w.logs[name]}`)).status,
      );
      expect(actual).toEqual(
        expected(LOGS, (name) =>
          viewer === 'noMember' ? 403 : VISIBLE_LOGS[viewer].includes(name) ? 200 : 404,
        ),
      );
    });

    it.each(VIEWERS)(
      'GET /work-logs/:id/attachments as %s follows the visibility of the log',
      async (viewer) => {
        const actual = await row(
          LOGS,
          async (name) => (await api(viewer).get(`/work-logs/${w.logs[name]}/attachments`)).status,
        );
        expect(actual).toEqual(
          expected(LOGS, (name) =>
            viewer === 'noMember' ? 403 : VISIBLE_LOGS[viewer].includes(name) ? 200 : 404,
          ),
        );
      },
    );
  });

  describe('tasks', () => {
    it.each(VIEWERS)('GET /tasks as %s lists exactly the visible tasks', async (viewer) => {
      const response = await api(viewer).get('/tasks', { pageSize: 100 });
      if (viewer === 'noMember') {
        expect(response.status).toBe(403);
        return;
      }
      expect(response.status).toBe(200);
      expect(namesOf(response)).toEqual([...VISIBLE_TASKS[viewer]].sort());
    });

    it.each(VIEWERS)('GET /tasks/:id as %s: 200 if visible, else 404', async (viewer) => {
      const actual = await row(
        TASKS,
        async (name) => (await api(viewer).get(`/tasks/${w.tasks[name]}`)).status,
      );
      expect(actual).toEqual(
        expected(TASKS, (name) =>
          viewer === 'noMember' ? 403 : VISIBLE_TASKS[viewer].includes(name) ? 200 : 404,
        ),
      );
    });

    it('exposes people on a task as ids only, to every viewer', async () => {
      const response = await api('wNone').get(`/tasks/${w.tasks.task2}`);
      expect(response.status).toBe(200);
      expect(taskSchema.strict().safeParse(response.body).success).toBe(true);
      expect(response.body.createdById).toBe(w.users.manager);
      expect([...response.body.assigneeIds].sort()).toEqual([w.users.wC, w.users.wNone].sort());
      for (const secret of ['@alpha.example.test', '+90555', 'Person manager', 'Person wC']) {
        expect(response.text).not.toContain(secret);
      }
    });
  });

  describe('sites and teams', () => {
    it.each(VIEWERS)('GET /sites as %s lists exactly the visible sites', async (viewer) => {
      const response = await api(viewer).get('/sites', { pageSize: 100 });
      if (viewer === 'noMember') {
        expect(response.status).toBe(403);
        return;
      }
      expect(namesOf(response)).toEqual([...VISIBLE_SITES[viewer]].sort());
    });

    it.each(VIEWERS)('GET /sites/:id as %s: 200 if visible, else 404', async (viewer) => {
      const actual = await row(
        SITES,
        async (name) => (await api(viewer).get(`/sites/${w.sites[name]}`)).status,
      );
      expect(actual).toEqual(
        expected(SITES, (name) =>
          viewer === 'noMember' ? 403 : VISIBLE_SITES[viewer].includes(name) ? 200 : 404,
        ),
      );
    });

    it.each(VIEWERS)('GET /teams as %s lists exactly the visible teams', async (viewer) => {
      const response = await api(viewer).get('/teams', { pageSize: 100 });
      if (viewer === 'noMember') {
        expect(response.status).toBe(403);
        return;
      }
      expect(namesOf(response)).toEqual([...VISIBLE_TEAMS[viewer]].sort());
    });

    it.each(VIEWERS)('GET /teams/:id as %s: 200 if visible, else 404', async (viewer) => {
      const actual = await row(
        TEAMS,
        async (name) => (await api(viewer).get(`/teams/${w.teams[name]}`)).status,
      );
      expect(actual).toEqual(
        expected(TEAMS, (name) =>
          viewer === 'noMember' ? 403 : VISIBLE_TEAMS[viewer].includes(name) ? 200 : 404,
        ),
      );
    });
  });

  describe('users', () => {
    it.each(VIEWERS)(
      'GET /users as %s lists the visible users, each in its shape',
      async (viewer) => {
        const response = await api(viewer).get('/users', { pageSize: 100 });
        if (viewer === 'noMember') {
          expect(response.status).toBe(403);
          return;
        }
        expect(response.status).toBe(200);
        const actual = Object.fromEntries(
          (response.body.items as Json[]).map((item) => [
            w.nameOf(item.id as string),
            item.profile,
          ]),
        );
        expect(actual).toEqual(VISIBLE_USERS[viewer]);
        for (const item of response.body.items as Json[]) {
          expect(Object.keys(item).sort()).toEqual(
            KEYS_OF_LEVEL[item.profile as keyof typeof KEYS_OF_LEVEL],
          );
          expect(userSchema.safeParse(item).success).toBe(true);
        }
      },
    );

    it.each(VIEWERS)(
      'GET /users/:id as %s: the shape it is entitled to, else 404',
      async (viewer) => {
        const actual: Record<string, string | number> = {};
        for (const name of USERS) {
          const response = await api(viewer).get(`/users/${w.users[name]}`);
          actual[name] = response.status === 200 ? response.body.profile : response.status;
          if (response.status === 200) {
            expect(Object.keys(response.body).sort()).toEqual(
              KEYS_OF_LEVEL[response.body.profile as keyof typeof KEYS_OF_LEVEL],
            );
          }
        }
        expect(actual).toEqual(
          Object.fromEntries(
            USERS.map((name) => [
              name,
              viewer === 'noMember' ? 403 : (VISIBLE_USERS[viewer][name as UserName] ?? 404),
            ]),
          ),
        );
      },
    );

    it('a worker seeing a colleague gets the basic shape: no email, no phone', async () => {
      const response = await api('wA').get(`/users/${w.users.wB}`);
      expect(response.body).toEqual({
        profile: 'basic',
        id: w.users.wB,
        displayName: 'Person wB',
        roles: ['worker'],
      });
      expect(response.text).not.toContain('@alpha.example.test');
    });

    it('roles of a dual-membership user come highest first, in every shape', async () => {
      for (const viewer of ['wA', 'supS1', 'admin1'] as const) {
        expect((await api(viewer).get(`/users/${w.users.dual}`)).body.roles).toEqual([
          'supervisor',
          'worker',
        ]);
      }
    });
  });

  describe('organization', () => {
    it.each(VIEWERS)(
      'GET /organization as %s: full for admins, summary for others',
      async (viewer) => {
        const response = await api(viewer).get('/organization');
        if (viewer === 'noMember') {
          expect(response.status).toBe(403);
          return;
        }
        expect(response.status).toBe(200);
        expect(response.body.id).toBe(w.alpha.id);
        if (ADMINS.includes(viewer)) {
          expect(response.body.view).toBe('full');
          expect(Object.keys(response.body).sort()).toEqual(
            [
              'archivedAt',
              'createdAt',
              'id',
              'name',
              'offlineMaxBackdateDays',
              'settings',
              'slug',
              'updatedAt',
              'view',
              'workLogEditWindowHours',
            ].sort(),
          );
        } else {
          expect(response.body).toEqual({
            view: 'summary',
            id: w.alpha.id,
            name: 'Alpha Works',
            slug: w.alpha.slug,
            workLogEditWindowHours: 24,
            offlineMaxBackdateDays: 7,
          });
        }
      },
    );
  });

  describe('scope, memberships, log types, audit and outbox reads', () => {
    it.each(VIEWERS)('GET /scope/me as %s works for any signed-in user', async (viewer) => {
      const response = await api(viewer).get('/scope/me');
      expect(response.status).toBe(200);
      expect(response.body.userId).toBe(w.users[viewer]);
    });

    it.each(VIEWERS)('admin-only reads as %s', async (viewer) => {
      const admin = ADMINS.includes(viewer);
      const membershipId = w.memberships.wA?.[0];
      const reads = {
        'GET /users/:id/scope': (await api(viewer).get(`/users/${w.users.wA}/scope`)).status,
        'GET /memberships': (await api(viewer).get('/memberships')).status,
        'GET /memberships/:id': (await api(viewer).get(`/memberships/${membershipId}`)).status,
        'GET /audit-events': (await api(viewer).get('/audit-events')).status,
        'GET /audit-events/:id': (await api(viewer).get(`/audit-events/${auditEventId}`)).status,
        'GET /outbox-events': (await api(viewer).get('/outbox-events')).status,
      };
      const ok = admin ? 200 : 403;
      expect(reads).toEqual({
        'GET /users/:id/scope': ok,
        'GET /memberships': ok,
        'GET /memberships/:id': ok,
        'GET /audit-events': ok,
        'GET /audit-events/:id': ok,
        'GET /outbox-events': ok,
      });
    });

    // Policy sync.pull (ADR-0008): every role; the content is the caller's own slice, through
    // the visibility filters. Beta's records never appear.
    it.each(VIEWERS)('GET /sync/pull as %s: own slice only', async (viewer) => {
      const response = await api(viewer).get('/sync/pull');
      if (viewer === 'noMember') {
        expect(response.status).toBe(403);
        return;
      }
      expect(response.status).toBe(200);
      const names = (ids: string[]) => ids.map((id) => w.nameOf(id)).sort();
      const body = response.body;
      const assigned = TASKS.filter(
        (task) =>
          TASK_TEMPLATES[task].org === 'alpha' &&
          TASK_TEMPLATES[task].assignees.includes(viewer) &&
          VISIBLE_TASKS[viewer].includes(task),
      );
      const own = (Object.keys(LOG_TEMPLATES) as LogName[]).filter(
        (log) => LOG_TEMPLATES[log].author === viewer && LOG_TEMPLATES[log].org === 'alpha',
      );
      expect({
        full: body.full,
        organization: body.organization.id,
        tasks: names(body.tasks.ids),
        sites: names(body.sites.ids),
        teams: names(body.teams.ids),
        workLogs: names(body.workLogs.ids),
        logTypes: body.logTypes.ids,
      }).toEqual({
        full: true,
        organization: w.alpha.id,
        tasks: [...assigned].sort(),
        sites: [...VISIBLE_SITES[viewer]].sort(),
        teams: [...VISIBLE_TEAMS[viewer]].sort(),
        workLogs: own.sort(),
        logTypes: [w.logTypeId],
      });
      // A full pull sends every record of the sets, and nothing else.
      for (const resource of ['tasks', 'sites', 'teams', 'workLogs', 'logTypes'] as const) {
        expect((body[resource].upserts as Json[]).map((item) => item.id).sort()).toEqual(
          [...body[resource].ids].sort(),
        );
      }
    });

    it.each(VIEWERS)('GET /log-types as %s: every member reads them', async (viewer) => {
      const list = await api(viewer).get('/log-types');
      const one = await api(viewer).get(`/log-types/${w.logTypeId}`);
      const status = viewer === 'noMember' ? 403 : 200;
      expect([list.status, one.status]).toEqual([status, status]);
    });
  });
});

describe('permissions matrix: who may change what', () => {
  let ctx: TestApp;
  let w: MatrixWorld;
  const api = (viewer: Viewer): ApiCaller => ctx.as(w.users[viewer]);

  beforeAll(async () => {
    ctx = await startTestApp();
    await ctx.reset();
    w = await buildMatrixWorld(ctx.prisma);
  });
  afterAll(() => ctx.close());

  const logVisible = (viewer: Viewer, name: LogName) => VISIBLE_LOGS[viewer].includes(name);
  const isAuthor = (viewer: Viewer, name: LogName) => LOG_TEMPLATES[name].author === viewer;

  describe('work logs (fresh copy of each fixture log per cell)', () => {
    /** The answer for a reviewer-or-author action such as archiving. */
    const authorOrReviewer = (viewer: Viewer, name: LogName, ok: number) =>
      viewer === 'noMember'
        ? 403
        : !logVisible(viewer, name)
          ? 404
          : isAuthor(viewer, name) || isSupervisorOrAbove(viewer)
            ? ok
            : 403;

    it.each(VIEWERS)('edit content as %s: the author only', async (viewer) => {
      const actual = await row(LOGS, async (name) => {
        const id = await w.freshLog(name);
        return (await api(viewer).patch(`/work-logs/${id}`, { text: 'Edited' })).status;
      });
      expect(actual).toEqual(
        expected(LOGS, (name) =>
          viewer === 'noMember'
            ? 403
            : !logVisible(viewer, name)
              ? 404
              : isAuthor(viewer, name)
                ? 200
                : 403,
        ),
      );
    });

    it.each(VIEWERS)(
      'approve (submitted -> approved) as %s: a reviewer, never the author',
      async (viewer) => {
        const actual = await row(LOGS, async (name) => {
          const id = await w.freshLog(name);
          return (await api(viewer).patch(`/work-logs/${id}/status`, { status: 'approved' }))
            .status;
        });
        expect(actual).toEqual(
          expected(LOGS, (name) =>
            viewer === 'noMember'
              ? 403
              : !logVisible(viewer, name)
                ? 404
                : isAuthor(viewer, name)
                  ? 403
                  : isSupervisorOrAbove(viewer)
                    ? 200
                    : 403,
          ),
        );
      },
    );

    it.each(VIEWERS)(
      'reject (submitted -> rejected) as %s: a reviewer, never the author',
      async (viewer) => {
        const actual = await row(LOGS, async (name) => {
          const id = await w.freshLog(name);
          return (
            await api(viewer).patch(`/work-logs/${id}/status`, {
              status: 'rejected',
              note: 'Not acceptable',
            })
          ).status;
        });
        expect(actual).toEqual(
          expected(LOGS, (name) =>
            viewer === 'noMember'
              ? 403
              : !logVisible(viewer, name)
                ? 404
                : !isAuthor(viewer, name) && isSupervisorOrAbove(viewer)
                  ? 200
                  : 403,
          ),
        );
      },
    );

    it.each(VIEWERS)(
      'back to draft (submitted -> draft) as %s: the author only',
      async (viewer) => {
        const actual = await row(LOGS, async (name) => {
          const id = await w.freshLog(name);
          return (await api(viewer).patch(`/work-logs/${id}/status`, { status: 'draft' })).status;
        });
        expect(actual).toEqual(
          expected(LOGS, (name) =>
            viewer === 'noMember'
              ? 403
              : !logVisible(viewer, name)
                ? 404
                : isAuthor(viewer, name)
                  ? 200
                  : 403,
          ),
        );
      },
    );

    it.each(VIEWERS)(
      'reopen (approved -> submitted) as %s: a reviewer, never the author',
      async (viewer) => {
        const actual = await row(LOGS, async (name) => {
          const id = await w.freshLog(name, { status: 'approved' });
          return (await api(viewer).patch(`/work-logs/${id}/status`, { status: 'submitted' }))
            .status;
        });
        expect(actual).toEqual(
          expected(LOGS, (name) =>
            viewer === 'noMember'
              ? 403
              : !logVisible(viewer, name)
                ? 404
                : !isAuthor(viewer, name) && isSupervisorOrAbove(viewer)
                  ? 200
                  : 403,
          ),
        );
      },
    );

    it.each(VIEWERS)(
      'resubmit (rejected -> submitted) as %s: the author, or a reviewer',
      async (viewer) => {
        const actual = await row(LOGS, async (name) => {
          const id = await w.freshLog(name, { status: 'rejected' });
          return (await api(viewer).patch(`/work-logs/${id}/status`, { status: 'submitted' }))
            .status;
        });
        expect(actual).toEqual(expected(LOGS, (name) => authorOrReviewer(viewer, name, 200)));
      },
    );

    it.each(VIEWERS)(
      'a move nobody may make (draft -> approved) as %s: 409 when visible',
      async (viewer) => {
        const actual = await row(LOGS, async (name) => {
          const id = await w.freshLog(name, { status: 'draft' });
          return (await api(viewer).patch(`/work-logs/${id}/status`, { status: 'approved' }))
            .status;
        });
        expect(actual).toEqual(
          expected(LOGS, (name) =>
            viewer === 'noMember' ? 403 : !logVisible(viewer, name) ? 404 : 409,
          ),
        );
      },
    );

    it.each(VIEWERS)(
      'archive as %s: the author, or a reviewer who did not write it',
      async (viewer) => {
        const actual = await row(LOGS, async (name) => {
          const id = await w.freshLog(name);
          return (await api(viewer).post(`/work-logs/${id}/archive`)).status;
        });
        expect(actual).toEqual(expected(LOGS, (name) => authorOrReviewer(viewer, name, 200)));
      },
    );

    it.each(VIEWERS)('add an attachment as %s: follows the parent log', async (viewer) => {
      const actual = await row(LOGS, async (name) => {
        const id = await w.freshLog(name);
        return (
          await api(viewer).post(`/work-logs/${id}/attachments`, {
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 10,
          })
        ).status;
      });
      expect(actual).toEqual(expected(LOGS, (name) => authorOrReviewer(viewer, name, 201)));
    });

    it.each(VIEWERS)(
      'read and archive an attachment as %s: follows the parent log',
      async (viewer) => {
        const reads: Record<string, number> = {};
        const archives: Record<string, number> = {};
        for (const name of LOGS) {
          const logId = await w.freshLog(name);
          const template = LOG_TEMPLATES[name];
          const attachment = await ctx.prisma.attachment.create({
            data: {
              organizationId: w.orgOf(template.org),
              workLogId: logId,
              uploadedById: w.users[template.author],
              fileName: 'photo.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 10,
              storageKey: `matrix/${randomUUID()}`,
              status: 'ready',
              thumbnailKey: `matrix/${randomUUID()}.thumb.jpg`,
            },
          });
          reads[name] = (await api(viewer).get(`/attachments/${attachment.id}`)).status;
          archives[name] = (await api(viewer).post(`/attachments/${attachment.id}/archive`)).status;
        }
        expect(reads).toEqual(
          expected(LOGS, (name) =>
            viewer === 'noMember' ? 403 : logVisible(viewer, name) ? 200 : 404,
          ),
        );
        expect(archives).toEqual(expected(LOGS, (name) => authorOrReviewer(viewer, name, 200)));
      },
    );

    it.each(VIEWERS)(
      'create a work log as %s: own log; references must be visible',
      async (viewer) => {
        const post = (extra: Record<string, unknown>) =>
          api(viewer).post('/work-logs', {
            clientId: randomUUID(),
            occurredAt: at().toISOString(),
            ...extra,
          });
        const plain = await post({});
        const statuses = {
          plain: plain.status,
          siteS1: (await post({ siteId: w.sites.S1 })).status,
          teamT2: (await post({ teamId: w.teams.T2 })).status,
          task1: (await post({ taskId: w.tasks.task1 })).status,
          foreignSite: (await post({ siteId: w.sites.SB })).status,
        };
        if (viewer === 'noMember') {
          expect(statuses).toEqual({
            plain: 403,
            siteS1: 403,
            teamT2: 403,
            task1: 403,
            foreignSite: 403,
          });
          return;
        }
        expect(plain.body.authorId).toBe(w.users[viewer]);
        expect(statuses).toEqual({
          plain: 201,
          siteS1: VISIBLE_SITES[viewer].includes('S1') ? 201 : 422,
          teamT2: VISIBLE_TEAMS[viewer].includes('T2') ? 201 : 422,
          task1: VISIBLE_TASKS[viewer].includes('task1') ? 201 : 422,
          foreignSite: 422,
        });
      },
    );
  });

  describe('tasks (fresh copy of each fixture task per cell)', () => {
    const taskVisible = (viewer: Viewer, name: TaskName) => VISIBLE_TASKS[viewer].includes(name);

    /** May this viewer manage (edit, assign, archive) the task? As an HTTP status. */
    const manage = (viewer: Viewer, name: TaskName, ok = 200): number => {
      if (viewer === 'noMember' || WORKERS.includes(viewer)) {
        return 403; // the role may not use the route at all
      }
      if (!taskVisible(viewer, name)) {
        return 404;
      }
      if (ORG_WIDE.includes(viewer)) {
        return ok;
      }
      const scope = SUPERVISOR_SCOPE[viewer]!;
      const template = TASK_TEMPLATES[name];
      const inScope =
        (template.site !== null && scope.sites.includes(template.site)) ||
        (template.team !== null && scope.teams.includes(template.team));
      return inScope ? ok : 403;
    };

    const isAssignee = (viewer: Viewer, name: TaskName) =>
      TASK_TEMPLATES[name].assignees.includes(viewer);

    it.each(VIEWERS)('edit as %s: managers of the task only', async (viewer) => {
      const actual = await row(TASKS, async (name) => {
        const id = await w.freshTask(name);
        return (await api(viewer).patch(`/tasks/${id}`, { title: 'Edited' })).status;
      });
      expect(actual).toEqual(expected(TASKS, (name) => manage(viewer, name)));
    });

    it.each(VIEWERS)('replace assignees as %s: managers of the task only', async (viewer) => {
      const actual = await row(TASKS, async (name) => {
        const id = await w.freshTask(name);
        // The same list: this cell is about the right to assign, not about who.
        const assigneeIds = TASK_TEMPLATES[name].assignees.map((user) => w.users[user]);
        return (await api(viewer).put(`/tasks/${id}/assignees`, { assigneeIds })).status;
      });
      expect(actual).toEqual(expected(TASKS, (name) => manage(viewer, name)));
    });

    it.each(VIEWERS)('archive as %s: managers of the task only', async (viewer) => {
      const actual = await row(TASKS, async (name) => {
        const id = await w.freshTask(name);
        return (await api(viewer).post(`/tasks/${id}/archive`)).status;
      });
      expect(actual).toEqual(expected(TASKS, (name) => manage(viewer, name)));
    });

    it.each(VIEWERS)('status -> in_progress as %s: managers and assignees', async (viewer) => {
      const actual = await row(TASKS, async (name) => {
        const id = await w.freshTask(name);
        return (await api(viewer).patch(`/tasks/${id}/status`, { status: 'in_progress' })).status;
      });
      expect(actual).toEqual(
        expected(TASKS, (name) => {
          if (viewer === 'noMember') return 403;
          if (!taskVisible(viewer, name)) return 404;
          if (!WORKERS.includes(viewer) && manage(viewer, name) === 200) return 200;
          return isAssignee(viewer, name) ? 200 : 403;
        }),
      );
    });

    it.each(VIEWERS)(
      'status -> cancelled as %s: managers only, never a plain assignee',
      async (viewer) => {
        const actual = await row(TASKS, async (name) => {
          const id = await w.freshTask(name);
          return (await api(viewer).patch(`/tasks/${id}/status`, { status: 'cancelled' })).status;
        });
        expect(actual).toEqual(
          expected(TASKS, (name) => {
            if (viewer === 'noMember') return 403;
            if (!taskVisible(viewer, name)) return 404;
            if (!WORKERS.includes(viewer) && manage(viewer, name) === 200) return 200;
            return 403;
          }),
        );
      },
    );

    it.each(VIEWERS)(
      'create as %s: placed in scope (403), references visible (422)',
      async (viewer) => {
        const bodies: Record<string, { site?: SiteName; team?: TeamName }> = {
          siteS1: { site: 'S1' },
          siteS1c: { site: 'S1c' },
          siteS2: { site: 'S2' },
          teamT2: { team: 'T2' },
          teamT1c: { team: 'T1c' },
          siteS2teamT1: { site: 'S2', team: 'T1' },
          noPlace: {},
          foreignSite: { site: 'SB' },
        };
        const actual: Record<string, number> = {};
        for (const [label, body] of Object.entries(bodies)) {
          const response = await api(viewer).post('/tasks', {
            title: `New ${label}`,
            ...(body.site ? { siteId: w.sites[body.site] } : {}),
            ...(body.team ? { teamId: w.teams[body.team] } : {}),
          });
          actual[label] = response.status;
          if (response.status === 201) {
            expect(response.body.createdById).toBe(w.users[viewer]);
          }
        }
        const decide = (body: { site?: SiteName; team?: TeamName }): number => {
          if (viewer === 'noMember' || WORKERS.includes(viewer)) return 403;
          if (body.site === 'SB') return 422;
          if (ORG_WIDE.includes(viewer)) return 201;
          const seen =
            (!body.site || VISIBLE_SITES[viewer].includes(body.site)) &&
            (!body.team || VISIBLE_TEAMS[viewer].includes(body.team));
          if (!seen) return 422;
          const scope = SUPERVISOR_SCOPE[viewer]!;
          const inScope =
            (body.site !== undefined && scope.sites.includes(body.site)) ||
            (body.team !== undefined && scope.teams.includes(body.team));
          return inScope ? 201 : 403;
        };
        expect(actual).toEqual(
          Object.fromEntries(Object.entries(bodies).map(([label, body]) => [label, decide(body)])),
        );
      },
    );
  });

  describe('sites, teams and log types', () => {
    it.each(VIEWERS)('manage sites as %s: managers and admins only', async (viewer) => {
      const site = await createSite(ctx.prisma, w.alpha.id);
      const archivable = await createSite(ctx.prisma, w.alpha.id);
      const restorable = await createSite(ctx.prisma, w.alpha.id, { archivedAt: at() });
      const actual = {
        create: (await api(viewer).post('/sites', { name: `Site by ${viewer}` })).status,
        update: (await api(viewer).patch(`/sites/${site.id}`, { name: 'Renamed' })).status,
        archive: (await api(viewer).post(`/sites/${archivable.id}/archive`)).status,
        restore: (await api(viewer).post(`/sites/${restorable.id}/restore`)).status,
      };
      const allowed = ORG_WIDE.includes(viewer);
      expect(actual).toEqual(
        allowed
          ? { create: 201, update: 200, archive: 200, restore: 200 }
          : { create: 403, update: 403, archive: 403, restore: 403 },
      );
    });

    it.each(VIEWERS)('manage teams as %s: managers and admins only', async (viewer) => {
      const team = await createTeam(ctx.prisma, w.alpha.id);
      const archivable = await createTeam(ctx.prisma, w.alpha.id);
      const restorable = await createTeam(ctx.prisma, w.alpha.id, { archivedAt: at() });
      const actual = {
        create: (await api(viewer).post('/teams', { name: `Team by ${viewer}` })).status,
        update: (await api(viewer).patch(`/teams/${team.id}`, { name: 'Renamed' })).status,
        archive: (await api(viewer).post(`/teams/${archivable.id}/archive`)).status,
        restore: (await api(viewer).post(`/teams/${restorable.id}/restore`)).status,
      };
      const allowed = ORG_WIDE.includes(viewer);
      expect(actual).toEqual(
        allowed
          ? { create: 201, update: 200, archive: 200, restore: 200 }
          : { create: 403, update: 403, archive: 403, restore: 403 },
      );
    });

    it.each(VIEWERS)('manage log types as %s: managers and admins only', async (viewer) => {
      const logType = await createLogType(ctx.prisma, w.alpha.id);
      const archivable = await createLogType(ctx.prisma, w.alpha.id);
      const actual = {
        create: (
          await api(viewer).post('/log-types', {
            key: `by_${viewer.toLowerCase()}`,
            name: `By ${viewer}`,
          })
        ).status,
        update: (await api(viewer).patch(`/log-types/${logType.id}`, { name: 'Renamed' })).status,
        archive: (await api(viewer).post(`/log-types/${archivable.id}/archive`)).status,
      };
      const allowed = ORG_WIDE.includes(viewer);
      expect(actual).toEqual(
        allowed
          ? { create: 201, update: 200, archive: 200 }
          : { create: 403, update: 403, archive: 403 },
      );
    });
  });

  describe('users, memberships and the organization', () => {
    it.each(VIEWERS)('rename users as %s: oneself, or anyone as an admin', async (viewer) => {
      const actual = await row(
        USERS,
        async (name) =>
          (await api(viewer).patch(`/users/${w.users[name]}`, { displayName: `Renamed ${name}` }))
            .status,
      );
      expect(actual).toEqual(
        expected(USERS, (name) => {
          if (viewer === 'noMember') return 403;
          if (name === viewer) return 200;
          if (!VISIBLE_USERS[viewer][name]) return 404;
          return ADMINS.includes(viewer) ? 200 : 403;
        }),
      );
    });

    it.each(VIEWERS)('change one’s own identifiers as %s: admins only', async (viewer) => {
      const email = (
        await api(viewer).patch(`/users/${w.users[viewer]}`, {
          email: `${viewer.toLowerCase()}.new@alpha.example.test`,
        })
      ).status;
      const username = (
        await api(viewer).patch(`/users/${w.users[viewer]}`, {
          username: `${viewer.toLowerCase()}.name`,
        })
      ).status;
      // Allowed field plus a refused one: the whole change is refused.
      const mixed = (
        await api(viewer).patch(`/users/${w.users[viewer]}`, {
          displayName: 'Still me',
          phone: `+9055599900${String(VIEWERS.indexOf(viewer)).padStart(2, '0')}`,
        })
      ).status;
      const status = ADMINS.includes(viewer) ? 200 : 403;
      expect({ email, username, mixed }).toEqual({
        email: status,
        username: status,
        mixed: status,
      });
      if (!ADMINS.includes(viewer)) {
        const stored = await ctx.prisma.user.findUniqueOrThrow({ where: { id: w.users[viewer] } });
        expect(stored.displayName).not.toBe('Still me');
        expect(stored.username).toBeNull();
      }
    });

    it.each(VIEWERS)('manage users as %s: admins only', async (viewer) => {
      const target = await createUser(ctx.prisma, w.alpha.id);
      const archivable = await createUser(ctx.prisma, w.alpha.id);
      const restorable = await createUser(ctx.prisma, w.alpha.id, { archivedAt: at() });
      const activated = await createUser(ctx.prisma, w.alpha.id);
      await ctx.setPassword(activated.id, 'matrix example passphrase');
      const actual = {
        create: (
          await api(viewer).post('/users', {
            displayName: `Made by ${viewer}`,
            username: `made.by.${viewer.toLowerCase()}`,
          })
        ).status,
        archive: (await api(viewer).post(`/users/${archivable.id}/archive`)).status,
        restore: (await api(viewer).post(`/users/${restorable.id}/restore`)).status,
        activationCode: (await api(viewer).post(`/users/${target.id}/activation-code`)).status,
        passwordReset: (await api(viewer).post(`/users/${activated.id}/password-reset`)).status,
      };
      expect(actual).toEqual(
        ADMINS.includes(viewer)
          ? { create: 201, archive: 200, restore: 200, activationCode: 200, passwordReset: 200 }
          : { create: 403, archive: 403, restore: 403, activationCode: 403, passwordReset: 403 },
      );
    });

    it.each(VIEWERS)('manage memberships as %s: admins only', async (viewer) => {
      const user = await createUser(ctx.prisma, w.alpha.id);
      const updatable = await createMembership(ctx.prisma, w.alpha.id, user.id, 'worker', {
        siteIds: [w.sites.S1],
      });
      const archivable = await createMembership(ctx.prisma, w.alpha.id, user.id, 'worker', {
        teamIds: [w.teams.T1],
      });
      const actual = {
        create: (
          await api(viewer).post('/memberships', {
            userId: user.id,
            role: 'worker',
            siteIds: [w.sites.S2],
          })
        ).status,
        update: (
          await api(viewer).patch(`/memberships/${updatable.id}`, { siteIds: [w.sites.S1c] })
        ).status,
        archive: (await api(viewer).post(`/memberships/${archivable.id}/archive`)).status,
      };
      expect(actual).toEqual(
        ADMINS.includes(viewer)
          ? { create: 201, update: 200, archive: 200 }
          : { create: 403, update: 403, archive: 403 },
      );
    });

    it.each(VIEWERS)('update the organization as %s: admins only', async (viewer) => {
      const response = await api(viewer).patch('/organization', { name: 'Alpha Works' });
      expect(response.status).toBe(ADMINS.includes(viewer) ? 200 : 403);
    });
  });

  describe('the other organization (tenant isolation, every role)', () => {
    it.each(VIEWERS.filter((viewer) => viewer !== 'noMember'))(
      'as %s, every record of Beta is 404 and a Beta id in a body is 422',
      async (viewer) => {
        const reads = [
          `/work-logs/${w.logs.logB2}`,
          `/tasks/${w.tasks.taskB}`,
          `/sites/${w.sites.SB}`,
          `/teams/${w.teams.TB}`,
          `/users/${w.users.adminB}`,
          `/users/${w.users.workerB}`,
        ];
        for (const path of reads) {
          expect([path, (await api(viewer).get(path)).status]).toEqual([path, 404]);
        }
        const writes = await Promise.all([
          api(viewer).patch(`/work-logs/${w.logs.logB2}`, { text: 'x' }),
          api(viewer).patch(`/work-logs/${w.logs.logB2}/status`, { status: 'approved' }),
          api(viewer).post(`/work-logs/${w.logs.logB2}/archive`),
          api(viewer).patch(`/tasks/${w.tasks.taskB}/status`, { status: 'done' }),
          api(viewer).patch(`/users/${w.users.workerB}`, { displayName: 'x' }),
        ]);
        expect(writes.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
        const created = await api(viewer).post('/work-logs', {
          clientId: randomUUID(),
          occurredAt: at().toISOString(),
          taskId: w.tasks.taskB,
        });
        expect(created.status).toBe(422);
      },
    );
  });
});
