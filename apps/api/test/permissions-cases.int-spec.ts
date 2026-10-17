import { randomUUID } from 'node:crypto';
import { at, createUser, eventCounts, unknownId } from './support/factories';
import { buildMatrixWorld, type MatrixWorld, type Viewer } from './support/matrix-world';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// The specific cases the owner listed for Phase 3, on the fixture of ./support/matrix-world.ts
// (rebuilt for every test). The full role-by-record grid is in permissions-matrix.int-spec.ts.

const HOUR = 3_600_000;

describe('permissions: the cases that matter most', () => {
  let ctx: TestApp;
  let w: MatrixWorld;
  const api = (viewer: Viewer): ApiCaller => ctx.as(w.users[viewer]);
  const ids = (response: { body: Json }) =>
    (response.body.items as Json[]).map((item) => w.nameOf(item.id as string)).sort();

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    w = await buildMatrixWorld(ctx.prisma);
  });
  afterAll(() => ctx.close());

  describe('a worker never sees another worker’s logs', () => {
    it('wA and wD work at the same site: lists exclude, reads and writes are 404', async () => {
      const other = w.logs.logD; // wD's log; wD shares S1c with wA
      const list = await api('wA').get('/work-logs', { pageSize: 100 });
      expect(ids(list)).toEqual(['logA']);
      expect((await api('wA').get('/work-logs', { authorId: w.users.wD })).body.total).toBe(0);

      const attempts = {
        get: (await api('wA').get(`/work-logs/${other}`)).status,
        update: (await api('wA').patch(`/work-logs/${other}`, { text: 'x' })).status,
        status: (await api('wA').patch(`/work-logs/${other}/status`, { status: 'draft' })).status,
        archive: (await api('wA').post(`/work-logs/${other}/archive`)).status,
        attachments: (await api('wA').get(`/work-logs/${other}/attachments`)).status,
        attach: (
          await api('wA').post(`/work-logs/${other}/attachments`, {
            fileName: 'x.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1,
          })
        ).status,
      };
      expect(attempts).toEqual({
        get: 404,
        update: 404,
        status: 404,
        archive: 404,
        attachments: 404,
        attach: 404,
      });
      // The 404 is the one of a log that does not exist.
      const missing = await api('wA').get(`/work-logs/${unknownId()}`);
      const hidden = await api('wA').get(`/work-logs/${other}`);
      expect(hidden.body.code).toBe(missing.body.code);
      expect(hidden.body.message).toBe(`Work log ${other} was not found`);
      const stored = await ctx.prisma.workLog.findUniqueOrThrow({ where: { id: other } });
      expect(stored).toMatchObject({ text: 'Log logD', status: 'submitted', archivedAt: null });
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });
  });

  describe('a supervisor never sees outside their scope', () => {
    it('supT2 (team T2) sees nothing of S1, S2 or T1: logs, tasks, sites, teams, users', async () => {
      const checks = {
        logA: (await api('supT2').get(`/work-logs/${w.logs.logA}`)).status,
        logMgr: (await api('supT2').get(`/work-logs/${w.logs.logMgr}`)).status,
        task1: (await api('supT2').get(`/tasks/${w.tasks.task1}`)).status,
        task5: (await api('supT2').get(`/tasks/${w.tasks.task5}`)).status,
        siteS1: (await api('supT2').get(`/sites/${w.sites.S1}`)).status,
        teamT1: (await api('supT2').get(`/teams/${w.teams.T1}`)).status,
        userWA: (await api('supT2').get(`/users/${w.users.wA}`)).status,
        userSupS1: (await api('supT2').get(`/users/${w.users.supS1}`)).status,
        archiveLogA: (await api('supT2').post(`/work-logs/${w.logs.logA}/archive`)).status,
        approveLogB: (
          await api('supT2').patch(`/work-logs/${w.logs.logB}/status`, { status: 'approved' })
        ).status,
        editTask1: (await api('supT2').patch(`/tasks/${w.tasks.task1}`, { title: 'x' })).status,
      };
      expect(checks).toEqual({
        logA: 404,
        logMgr: 404,
        task1: 404,
        task5: 404,
        siteS1: 404,
        teamT1: 404,
        userWA: 404,
        userSupS1: 404,
        archiveLogA: 404,
        approveLogB: 404,
        editTask1: 404,
      });
      // ...while what is in scope is there.
      expect(ids(await api('supT2').get('/work-logs'))).toEqual(['logC', 'logDual']);
    });

    it('a site supervisor does not see the supervisor of the parent site or the manager', async () => {
      // dual supervises S1c, a child of S1: supS1 (above) and the manager stay hidden.
      expect((await api('dual').get(`/users/${w.users.supS1}`)).status).toBe(404);
      expect((await api('dual').get(`/users/${w.users.manager}`)).status).toBe(404);
      expect((await api('dual').get(`/work-logs/${w.logs.logSupS1}`)).status).toBe(404);
    });
  });

  describe('several memberships give the union of what each grants', () => {
    it('a worker + supervisor membership: supervisor view over S1c, worker belonging in T2', async () => {
      const scope = (await api('dual').get('/scope/me')).body;
      expect(scope.roles).toEqual(['worker', 'supervisor']);
      expect(scope.siteIds).toEqual([w.sites.S1c]);
      expect(scope.memberOf.teamIds).toEqual([w.teams.T2]);
      // Logs of the people of S1c (supervisor) and their own (worker); not the T2 logs of others.
      expect(ids(await api('dual').get('/work-logs'))).toEqual(['logA', 'logB', 'logD', 'logDual']);
      // Sites from the supervisor membership, teams from the worker membership.
      expect(ids(await api('dual').get('/sites'))).toEqual(['S1c']);
      expect(ids(await api('dual').get('/teams'))).toEqual(['T2']);
    });

    it('two supervisor memberships add up, and losing one narrows the very next request', async () => {
      const response = await api('admin1').post('/memberships', {
        userId: w.users.supT2,
        role: 'supervisor',
        siteIds: [w.sites.S1],
      });
      expect(response.status).toBe(201);
      expect(ids(await api('supT2').get('/work-logs'))).toEqual([
        'logA',
        'logB',
        'logC',
        'logD',
        'logDual',
        'logSupS1',
      ]);

      expect((await api('admin1').post(`/memberships/${response.body.id}/archive`)).status).toBe(
        200,
      );
      expect(ids(await api('supT2').get('/work-logs'))).toEqual(['logC', 'logDual']);
    });
  });

  describe('nobody approves or rejects their own log', () => {
    it.each(['admin1', 'manager', 'supS1', 'dual'] as const)(
      '%s cannot approve, reject or reopen a log they wrote (403), but may review others',
      async (viewer) => {
        const own = await ctx.prisma.workLog.create({
          data: {
            organizationId: w.alpha.id,
            authorId: w.users[viewer],
            clientId: randomUUID(),
            occurredAt: at(),
            siteId: w.sites.S1c,
          },
        });
        const approve = await api(viewer).patch(`/work-logs/${own.id}/status`, {
          status: 'approved',
        });
        const reject = await api(viewer).patch(`/work-logs/${own.id}/status`, {
          status: 'rejected',
          note: 'Not acceptable',
        });
        expect([approve.status, reject.status]).toEqual([403, 403]);
        expect(approve.body.message).toBe('You cannot review your own work log');

        await ctx.prisma.workLog.update({ where: { id: own.id }, data: { status: 'approved' } });
        const reopen = await api(viewer).patch(`/work-logs/${own.id}/status`, {
          status: 'submitted',
        });
        expect(reopen.status).toBe(403);
        expect((await ctx.prisma.workLog.findUniqueOrThrow({ where: { id: own.id } })).status).toBe(
          'approved',
        );

        // Somebody else's log in their view: allowed.
        const approveOther = await api(viewer).patch(`/work-logs/${w.logs.logB}/status`, {
          status: 'approved',
        });
        expect(approveOther.status).toBe(200);
      },
    );

    it('a log created with status approved is refused (400): a reviewer sets it', async () => {
      const response = await api('admin1').post('/work-logs', {
        clientId: randomUUID(),
        occurredAt: at().toISOString(),
        status: 'approved',
      });
      expect(response.status).toBe(400);
      expect(await ctx.prisma.workLog.count({ where: { status: 'approved' } })).toBe(0);
    });
  });

  describe('no privilege escalation through memberships', () => {
    it.each(['wA', 'supS1', 'manager'] as const)(
      '%s cannot give themselves (or anyone) a membership, nor change their own',
      async (viewer) => {
        const before = await ctx.prisma.membership.count();
        const ownMembership = w.memberships[viewer]![0]!;
        const responses = await Promise.all([
          api(viewer).post('/memberships', {
            userId: w.users[viewer],
            role: 'admin',
            orgWide: true,
          }),
          api(viewer).post('/memberships', {
            userId: w.users.wNone,
            role: 'worker',
            siteIds: [w.sites.S1],
          }),
          api(viewer).patch(`/memberships/${ownMembership}`, { role: 'admin', orgWide: true }),
          api(viewer).patch(`/users/${w.users[viewer]}`, { username: 'boss' }),
        ]);
        expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
        expect(await ctx.prisma.membership.count()).toBe(before);
        expect(
          (await ctx.prisma.membership.findUniqueOrThrow({ where: { id: ownMembership } })).role,
        ).toBe(viewer === 'wA' ? 'worker' : viewer === 'supS1' ? 'supervisor' : 'manager');
      },
    );

    it.each([
      ['manager', { siteIds: ['S1'] }],
      ['admin', { teamIds: ['T1'] }],
      ['manager', { orgWide: false }],
    ] as const)('an admin cannot create a scoped %s membership (400): %j', async (role, scope) => {
      const body: Record<string, unknown> = { userId: w.users.wNone, role, orgWide: true };
      if ('siteIds' in scope) body.siteIds = scope.siteIds.map((name) => w.sites[name]);
      if ('teamIds' in scope) body.teamIds = scope.teamIds.map((name) => w.teams[name]);
      if ('orgWide' in scope) body.orgWide = scope.orgWide;
      const before = await ctx.prisma.membership.count();
      const response = await api('admin1').post('/memberships', body);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
      expect(await ctx.prisma.membership.count()).toBe(before);
    });

    it('an admin cannot turn a scoped membership into a scoped manager (400)', async () => {
      const membership = w.memberships.supS1![0]!;
      const response = await api('admin1').patch(`/memberships/${membership}`, {
        role: 'manager',
      });
      expect(response.status).toBe(400);
      // With the scope cleared at the same time, it is allowed.
      const fixed = await api('admin1').patch(`/memberships/${membership}`, {
        role: 'manager',
        orgWide: true,
        siteIds: [],
        teamIds: [],
      });
      expect(fixed.status).toBe(200);
    });

    describe('the last active admin', () => {
      /** Leaves admin1 as the only active admin of Alpha. */
      async function onlyAdmin1() {
        await ctx.prisma.membership.updateMany({
          where: { userId: w.users.admin2 },
          data: { archivedAt: at() },
        });
      }

      it('cannot be archived as a user (409)', async () => {
        await onlyAdmin1();
        const response = await api('admin1').post(`/users/${w.users.admin1}/archive`);
        expect(response.status).toBe(409);
        expect(response.body.message).toBe('The organization must keep at least one active admin');
        expect(
          (await ctx.prisma.user.findUniqueOrThrow({ where: { id: w.users.admin1 } })).archivedAt,
        ).toBeNull();
      });

      it('cannot lose the admin membership by archive (409) or demotion (409)', async () => {
        await onlyAdmin1();
        const membership = w.memberships.admin1![0]!;
        const archive = await api('admin1').post(`/memberships/${membership}/archive`);
        const demote = await api('admin1').patch(`/memberships/${membership}`, {
          role: 'manager',
        });
        expect([archive.status, demote.status]).toEqual([409, 409]);
        expect(
          await ctx.prisma.membership.findUniqueOrThrow({ where: { id: membership } }),
        ).toMatchObject({ role: 'admin', archivedAt: null });
      });

      it('counts an archived user’s admin membership as gone', async () => {
        await ctx.prisma.user.update({
          where: { id: w.users.admin2 },
          data: { archivedAt: at() },
        });
        expect((await api('admin1').post(`/users/${w.users.admin1}/archive`)).status).toBe(409);
      });

      it('may go while another admin remains', async () => {
        const response = await api('admin1').post(`/users/${w.users.admin2}/archive`);
        expect(response.status).toBe(200);
        // And now admin1 is the last one.
        expect(
          (await api('admin1').post(`/memberships/${w.memberships.admin1![0]}/archive`)).status,
        ).toBe(409);
      });

      it.each([
        ['archive each other as users', (target: Viewer) => `/users/${w.users[target]}/archive`],
        [
          'archive each other’s admin membership',
          (target: Viewer) => `/memberships/${w.memberships[target]![0]}/archive`,
        ],
      ])('two admins who %s at the same moment: exactly one wins', async (_name, pathOf) => {
        for (let round = 0; round < 3; round += 1) {
          if (round > 0) {
            await ctx.reset();
            w = await buildMatrixWorld(ctx.prisma);
          }
          // Warm both sessions first so the two requests really race.
          await api('admin1').get('/auth/me');
          await api('admin2').get('/auth/me');
          const [one, two] = await Promise.all([
            api('admin1').post(pathOf('admin2')),
            api('admin2').post(pathOf('admin1')),
          ]);
          const statuses = [one.status, two.status].sort();
          // The loser is refused: 409 when its check ran after the winner committed, or 401
          // when the winner had already ended the loser's session.
          expect(statuses[0]).toBe(200);
          expect([401, 409]).toContain(statuses[1]);
          const admins = await ctx.prisma.membership.count({
            where: {
              organizationId: w.alpha.id,
              role: 'admin',
              archivedAt: null,
              user: { archivedAt: null },
            },
          });
          expect(admins).toBe(1);
        }
      });
    });
  });

  describe('author fields are always set by the server', () => {
    it('authorId, createdById and uploadedById in a body are refused (400)', async () => {
      const someone = w.users.wB;
      const attempts = await Promise.all([
        api('wA').post('/work-logs', {
          clientId: randomUUID(),
          occurredAt: at().toISOString(),
          authorId: someone,
        }),
        api('wA').patch(`/work-logs/${w.logs.logA}`, { text: 'x', authorId: someone }),
        api('supS1').post('/tasks', {
          title: 'T',
          siteId: w.sites.S1,
          createdById: someone,
        }),
        api('supS1').patch(`/tasks/${w.tasks.task1}`, { title: 'x', createdById: someone }),
        api('wA').post(`/work-logs/${w.logs.logA}/attachments`, {
          fileName: 'a.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1,
          uploadedById: someone,
        }),
      ]);
      for (const response of attempts) {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('validation_failed');
        expect((response.body.details as Json[]).map((detail) => detail.path)).toEqual(
          expect.arrayContaining([expect.stringMatching(/^(authorId|createdById|uploadedById)$/)]),
        );
      }
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('the stored author, creator and uploader are the caller', async () => {
      const log = await api('wA').post('/work-logs', {
        clientId: randomUUID(),
        occurredAt: at().toISOString(),
      });
      const task = await api('supS1').post('/tasks', { title: 'T', siteId: w.sites.S1 });
      const attachment = await api('supS1').post(`/work-logs/${w.logs.logA}/attachments`, {
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
      });
      expect([log.status, task.status, attachment.status]).toEqual([201, 201, 201]);
      expect(
        (await ctx.prisma.workLog.findUniqueOrThrow({ where: { id: log.body.id } })).authorId,
      ).toBe(w.users.wA);
      expect(
        (await ctx.prisma.task.findUniqueOrThrow({ where: { id: task.body.id } })).createdById,
      ).toBe(w.users.supS1);
      expect(
        (
          await ctx.prisma.attachment.findUniqueOrThrow({
            where: { id: attachment.body.attachment.id },
          })
        ).uploadedById,
      ).toBe(w.users.supS1);
    });

    it('a clientId of another user’s log is a 409 that reveals nothing of that log', async () => {
      const stored = await ctx.prisma.workLog.findUniqueOrThrow({ where: { id: w.logs.logB } });
      const response = await api('wA').post('/work-logs', {
        clientId: stored.clientId,
        occurredAt: at().toISOString(),
        text: 'Mine',
      });
      expect(response.status).toBe(409);
      expect(response.body.details).toEqual([{ path: 'clientId', message: 'is already in use' }]);
      for (const leak of [stored.id, stored.text, w.users.wB]) {
        expect(response.text).not.toContain(leak);
      }
      // Its author still gets their log back on a retry.
      const retry = await api('wB').post('/work-logs', {
        clientId: stored.clientId,
        occurredAt: at().toISOString(),
      });
      expect(retry.status).toBe(200);
      expect(retry.body.id).toBe(stored.id);
    });
  });

  describe('references outside the caller’s scope look exactly like missing ones (422)', () => {
    /** The error with the ids replaced, so two answers can be compared. */
    const shape = (response: { status: number; body: Json }, ...hidden: string[]) => {
      let text = JSON.stringify({
        status: response.status,
        code: response.body.code,
        message: response.body.message,
        details: response.body.details,
      });
      for (const id of hidden) {
        text = text.replaceAll(id, '<id>');
      }
      return text;
    };

    it.each([
      ['work log site', 'wA', '/work-logs', 'siteId', () => w.sites.S2],
      ['work log team', 'wA', '/work-logs', 'teamId', () => w.teams.T2],
      ['work log task', 'wA', '/work-logs', 'taskId', () => w.tasks.task5],
      ['task site', 'supS1', '/tasks', 'siteId', () => w.sites.S2],
      ['task team', 'supS1', '/tasks', 'teamId', () => w.teams.T2],
      ['task assignee', 'supS1', '/tasks', 'assigneeIds', () => [w.users.wC]],
    ] as const)('%s', async (_name, viewer, path, field, hiddenValue) => {
      const base =
        path === '/work-logs'
          ? { clientId: randomUUID(), occurredAt: at().toISOString() }
          : { title: 'T', siteId: w.sites.S1 };
      const hidden = hiddenValue();
      const missing = Array.isArray(hidden) ? [unknownId()] : unknownId();
      const outside = await api(viewer).post(path, { ...base, [field]: hidden });
      const nowhere = await api(viewer).post(path, {
        ...base,
        ...(path === '/work-logs' ? { clientId: randomUUID() } : {}),
        [field]: missing,
      });
      const hiddenId = Array.isArray(hidden) ? hidden[0]! : hidden;
      const missingId = Array.isArray(missing) ? missing[0]! : missing;
      expect(outside.status).toBe(422);
      expect(shape(outside, hiddenId)).toBe(shape(nowhere, missingId));
    });

    it('an assignee who is not one of the supervisor’s people is 422 on re-assignment too', async () => {
      const response = await api('supS1').put(`/tasks/${w.tasks.task1}/assignees`, {
        assigneeIds: [w.users.wA, w.users.wC],
      });
      expect(response.status).toBe(422);
      expect(response.body.details).toEqual([
        {
          path: 'assigneeIds.1',
          message: `User ${w.users.wC} does not exist in this organization or is archived`,
        },
      ]);
      // One of their people: fine.
      const ok = await api('supS1').put(`/tasks/${w.tasks.task1}/assignees`, {
        assigneeIds: [w.users.wA, w.users.wD],
      });
      expect(ok.status).toBe(200);
    });
  });

  describe('list filters cannot reach past the caller’s visibility', () => {
    it('filters on an invisible site, team, author or assignee return nothing', async () => {
      const checks = {
        workerByAuthor: await api('wA').get('/work-logs', { authorId: w.users.wD }),
        workerBySite: await api('wA').get('/work-logs', { siteId: w.sites.S1c }),
        supByOutOfScopeSite: await api('supS1').get('/work-logs', { siteId: w.sites.S2 }),
        // (supS1 filtering on T2 would find logDual: its author is one of supS1's people.)
        supByOutOfScopeTeam: await api('supT2').get('/work-logs', { teamId: w.teams.T1 }),
        supByHiddenAuthor: await api('supS1').get('/work-logs', { authorId: w.users.wC }),
        workerTasksByAssignee: await api('wA').get('/tasks', { assigneeId: w.users.wB }),
        supTasksByAssignee: await api('supT2').get('/tasks', { assigneeId: w.users.wA }),
        supTasksBySite: await api('supT2').get('/tasks', { siteId: w.sites.S1 }),
        usersBySite: await api('supT2').get('/users', { siteId: w.sites.S1 }),
        usersByTeam: await api('supS1').get('/users', { teamId: w.teams.T2 }),
      };
      const totals = Object.fromEntries(
        Object.entries(checks).map(([name, response]) => [name, response.body.total]),
      );
      expect(totals).toEqual(Object.fromEntries(Object.keys(checks).map((name) => [name, 0])));
      // The same filters inside the visibility do match.
      expect((await api('supS1').get('/work-logs', { authorId: w.users.wD })).body.total).toBe(1);
      expect((await api('manager').get('/work-logs', { siteId: w.sites.S2 })).body.total).toBe(1);
    });
  });

  describe('user search does not reach fields the caller cannot see', () => {
    it('matches email and phone only of users whose contact details the caller sees', async () => {
      const search = async (viewer: Viewer, term: string) =>
        ids(await api(viewer).get('/users', { search: term }));
      // wA sees wB in the basic shape: the name matches, the email and the phone do not.
      expect(await search('wA', 'Person wB')).toEqual(['wB']);
      expect(await search('wA', 'wb@alpha')).toEqual([]);
      const phoneOfWB = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: w.users.wB } }))
        .phone!;
      expect(await search('wA', phoneOfWB.slice(-6))).toEqual([]);
      // Their own email does match.
      expect(await search('wA', 'wa@alpha')).toEqual(['wA']);
      // supS1 sees wB with contact details: the email matches.
      expect(await search('supS1', 'wb@alpha')).toEqual(['wB']);
      expect(await search('supS1', phoneOfWB.slice(-6))).toEqual(['wB']);
      // dual sees wC only in the basic shape.
      expect(await search('dual', 'wc@alpha')).toEqual([]);
      expect(await search('dual', 'Person wC')).toEqual(['wC']);
      // A manager sees everyone's contact details.
      expect(await search('manager', 'wc@alpha')).toEqual(['wC']);
    });

    it('sorting by email needs contact access to everyone (403 for a worker or supervisor)', async () => {
      expect((await api('wA').get('/users', { sort: 'email:asc' })).status).toBe(403);
      expect((await api('supS1').get('/users', { sort: 'email:asc' })).status).toBe(403);
      expect((await api('manager').get('/users', { sort: 'email:asc' })).status).toBe(200);
    });
  });

  describe('the edit window of the author', () => {
    async function ownLog(createdAt: Date, data: Record<string, unknown> = {}) {
      return (
        await ctx.prisma.workLog.create({
          data: {
            organizationId: w.alpha.id,
            authorId: w.users.wA,
            clientId: randomUUID(),
            occurredAt: at(),
            createdAt,
            ...data,
          },
        })
      ).id;
    }

    const attempts = async (id: string) => ({
      edit: (await api('wA').patch(`/work-logs/${id}`, { text: 'Edited' })).status,
      draft: (await api('wA').patch(`/work-logs/${id}/status`, { status: 'draft' })).status,
      attach: (
        await api('wA').post(`/work-logs/${id}/attachments`, {
          fileName: 'a.jpg',
          mimeType: 'image/jpeg',
          sizeBytes: 1,
        })
      ).status,
    });

    // The clock only moves forward in these tests: the harness renews tokens as time passes,
    // but a token issued "later" than a clock that was moved back would not be valid yet.
    const recently = () => new Date(Date.now() - 60_000);

    it('uses 24 hours by default: allowed at exactly 24 h, refused 1 ms later', async () => {
      const createdAt = recently();
      const id = await ownLog(createdAt);
      ctx.clock.freeze(new Date(createdAt.getTime() + 24 * HOUR));
      expect(await attempts(id)).toEqual({ edit: 200, draft: 200, attach: 201 });

      const late = await ownLog(createdAt);
      ctx.clock.freeze(new Date(createdAt.getTime() + 24 * HOUR + 1));
      expect(await attempts(late)).toEqual({ edit: 403, draft: 403, attach: 403 });
      expect((await api('wA').post(`/work-logs/${late}/archive`)).status).toBe(403);
      const refused = await api('wA').patch(`/work-logs/${late}`, { text: 'x' });
      expect(refused.body.message).toBe('The edit window of 24 hours for this work log has passed');
      // A reviewer is not bound by the author's window.
      expect(
        (await api('supS1').patch(`/work-logs/${late}/status`, { status: 'approved' })).status,
      ).toBe(200);
    });

    it('follows the organization setting (2 hours here)', async () => {
      const settings = await api('admin1').patch('/organization', {
        settings: { workLogEditWindowHours: 2 },
      });
      expect(settings.status).toBe(200);
      expect((await api('wA').get('/organization')).body.workLogEditWindowHours).toBe(2);
      const createdAt = recently();
      const inside = await ownLog(createdAt);
      const outside = await ownLog(createdAt);
      ctx.clock.freeze(new Date(createdAt.getTime() + 2 * HOUR));
      expect(await attempts(inside)).toEqual({ edit: 200, draft: 200, attach: 201 });
      ctx.clock.freeze(new Date(createdAt.getTime() + 2 * HOUR + 1));
      expect(await attempts(outside)).toEqual({ edit: 403, draft: 403, attach: 403 });
    });

    it('refuses an approved log to its author even inside the window', async () => {
      const id = await ownLog(new Date(), { status: 'approved' });
      const result = {
        edit: (await api('wA').patch(`/work-logs/${id}`, { text: 'x' })).status,
        archive: (await api('wA').post(`/work-logs/${id}/archive`)).status,
        attach: (
          await api('wA').post(`/work-logs/${id}/attachments`, {
            fileName: 'a.jpg',
            mimeType: 'image/jpeg',
            sizeBytes: 1,
          })
        ).status,
      };
      expect(result).toEqual({ edit: 403, archive: 403, attach: 403 });
    });

    it('lets the author resubmit a rejected log inside the window only', async () => {
      const createdAt = recently();
      const inside = await ownLog(createdAt, { status: 'rejected' });
      const outside = await ownLog(createdAt, { status: 'rejected' });
      ctx.clock.freeze(new Date(createdAt.getTime() + 23 * HOUR));
      expect(
        (await api('wA').patch(`/work-logs/${inside}/status`, { status: 'submitted' })).status,
      ).toBe(200);
      ctx.clock.freeze(new Date(createdAt.getTime() + 25 * HOUR));
      expect(
        (await api('wA').patch(`/work-logs/${outside}/status`, { status: 'submitted' })).status,
      ).toBe(403);
    });
  });

  describe('check order on writes: 404, then 403, then 409', () => {
    it('an archived log: hidden 404, visible but not allowed 403, allowed 409', async () => {
      const archived = await ctx.prisma.workLog.create({
        data: {
          organizationId: w.alpha.id,
          authorId: w.users.wA,
          clientId: randomUUID(),
          occurredAt: at(),
          siteId: w.sites.S1,
          archivedAt: new Date(),
        },
      });
      const edit = (viewer: Viewer) =>
        api(viewer).patch(`/work-logs/${archived.id}`, { text: 'x' });
      expect((await edit('wD')).status).toBe(404); // cannot see it
      expect((await edit('supS1')).status).toBe(403); // sees it, not the author
      expect((await edit('wA')).status).toBe(409); // the author: the state refuses
    });

    it('an archived task: hidden 404, visible but not managed 403, managed 409', async () => {
      const id = await w.freshTask('task2', { archivedAt: new Date() });
      const edit = (viewer: Viewer) => api(viewer).patch(`/tasks/${id}`, { title: 'x' });
      expect((await edit('supS1')).status).toBe(404);
      expect((await edit('supS2T1')).status).toBe(403); // sees it through wC, T2 not theirs
      expect((await edit('supT2')).status).toBe(409);
    });
  });

  describe('task status by an assignee', () => {
    it('cannot cancel, nor bring a cancelled task back (403); can move it otherwise', async () => {
      const id = await w.freshTask('task1');
      for (const status of ['in_progress', 'blocked', 'done', 'todo']) {
        const body = status === 'blocked' ? { status, reason: 'Waiting for parts' } : { status };
        expect((await api('wA').patch(`/tasks/${id}/status`, body)).status).toBe(200);
      }
      expect((await api('wA').patch(`/tasks/${id}/status`, { status: 'cancelled' })).status).toBe(
        403,
      );
      const cancelled = await w.freshTask('task1', { status: 'cancelled' });
      const reopen = await api('wA').patch(`/tasks/${cancelled}/status`, { status: 'todo' });
      expect(reopen.status).toBe(403);
      expect(reopen.body.message).toBe(
        'A cancelled task can only be reopened by whoever manages it',
      );
      // Whoever manages it can.
      expect(
        (await api('supS1').patch(`/tasks/${cancelled}/status`, { status: 'todo' })).status,
      ).toBe(200);
    });

    it('cannot edit, re-scope, reassign or archive their task (403)', async () => {
      const id = w.tasks.task1;
      const responses = await Promise.all([
        api('wA').patch(`/tasks/${id}`, { title: 'Mine now' }),
        api('wA').patch(`/tasks/${id}`, { siteId: w.sites.S1c }),
        api('wA').put(`/tasks/${id}/assignees`, { assigneeIds: [] }),
        api('wA').post(`/tasks/${id}/archive`),
      ]);
      expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    });
  });

  describe('a user with no membership', () => {
    it('can use the self routes, and gets 403 on every business route', async () => {
      const lonely = await createUser(ctx.prisma, w.alpha.id);
      const me = ctx.as(lonely.id);
      expect((await me.get('/auth/me')).status).toBe(200);
      expect((await me.get('/auth/sessions')).status).toBe(200);
      expect((await me.get('/scope/me')).body).toMatchObject({ roles: [], userIds: [lonely.id] });
      for (const path of [
        '/organization',
        '/users',
        `/users/${lonely.id}`,
        '/sites',
        '/log-types',
      ]) {
        expect([path, (await me.get(path)).status]).toEqual([path, 403]);
      }
      expect((await me.patch(`/users/${lonely.id}`, { displayName: 'Me' })).status).toBe(403);
    });
  });
});

describe('the outbox route in production', () => {
  let ctx: TestApp;
  let w: MatrixWorld;

  beforeAll(async () => {
    ctx = await startTestApp({ config: { NODE_ENV: 'production' } });
    await ctx.reset();
    w = await buildMatrixWorld(ctx.prisma);
  });
  afterAll(() => ctx.close());

  it('does not exist for anybody (404), admins included; audit stays admin-only', async () => {
    for (const viewer of ['admin1', 'manager', 'wA'] as const) {
      const response = await ctx.as(w.users[viewer]).get('/outbox-events');
      expect([viewer, response.status]).toEqual([viewer, 404]);
    }
    expect((await ctx.as(w.users.admin1).get('/audit-events')).status).toBe(200);
    expect((await ctx.as(w.users.manager).get('/audit-events')).status).toBe(403);
  });

  it('answers anonymous callers exactly like a route that does not exist', async () => {
    const anonymous = ctx.as(null);
    const outbox = await anonymous.get('/outbox-events');
    const missing = await anonymous.get('/no-such-route');
    expect(outbox.status).toBe(404);
    expect(outbox.body.code).toBe('not_found');
    expect(outbox.body.message).toBe('Cannot GET /outbox-events');
    expect(missing.body.message).toBe('Cannot GET /no-such-route');
    expect((await anonymous.get('/audit-events')).status).toBe(401);
  });
});
