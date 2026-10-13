import {
  membershipSchema,
  resolvedScopeSchema,
  siteSchema,
  teamSchema,
  userSchema,
} from '@ops/shared';
import {
  at,
  createMembership,
  createSite,
  createTeam,
  createTenant,
  createUser,
  eventCounts,
  unknownId,
  type Tenant,
} from './support/factories';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// Sites, teams, users, memberships and the scope read endpoints, over HTTP on real PostgreSQL.

describe('organization structure', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let other: Tenant;
  let api: ApiCaller;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    other = await createTenant(ctx.prisma, 'Other Org');
    api = ctx.as(tenant.admin.id);
  });
  afterAll(() => ctx.close());

  const orgId = () => tenant.organization.id;
  const names = (response: { body: Json }) =>
    (response.body.items as Json[]).map((item) => item.name);

  // Sites and teams share their rules: hierarchy, archive/restore, list conventions.
  describe.each([
    ['sites', 'Site', siteSchema, createSite],
    ['teams', 'Team', teamSchema, createTeam],
  ] as const)('%s', (path, label, schema, create) => {
    const make = (data: { name?: string; parentId?: string; archivedAt?: Date } = {}) =>
      create(ctx.prisma, orgId(), data);
    /** Rows of this kind in the whole database, every organization included. */
    const countRows = () => (path === 'sites' ? ctx.prisma.site.count() : ctx.prisma.team.count());

    describe('create, read, update', () => {
      it('creates a record (201) in the caller’s organization and returns the wire shape', async () => {
        const response = await api.post(`/${path}`, { name: '  North  ', description: 'Main' });
        expect(response.status).toBe(201);
        expect(schema.safeParse(response.body).success).toBe(true);
        expect(response.body).toMatchObject({
          organizationId: orgId(),
          name: 'North',
          description: 'Main',
          parentId: null,
          archivedAt: null,
        });

        const fetched = await api.get(`/${path}/${response.body.id}`);
        expect(fetched.status).toBe(200);
        expect(fetched.body).toEqual(response.body);
      });

      it.each([
        ['organizationId', () => other.organization.id],
        ['id', () => unknownId()],
        ['archivedAt', () => at().toISOString()],
        ['createdAt', () => at().toISOString()],
      ])('rejects a body that names %s (400), on create and on update', async (key, value) => {
        const record = await make({ name: 'Original' });

        const created = await api.post(`/${path}`, { name: 'North', [key]: value() });
        const updated = await api.patch(`/${path}/${record.id}`, {
          name: 'Renamed',
          [key]: value(),
        });

        for (const response of [created, updated]) {
          expect(response.status).toBe(400);
          expect(response.body.code).toBe('validation_failed');
          expect(response.body.details).toContainEqual({
            path: key,
            message: 'is not a recognised field',
          });
        }
        expect(await countRows()).toBe(1);
        expect((await api.get(`/${path}/${record.id}`)).body).toMatchObject({
          name: 'Original',
          organizationId: orgId(),
          archivedAt: null,
        });
        expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
      });

      it('names every unknown key of a body at once', async () => {
        const response = await api.post(`/${path}`, { name: 'North', colour: 'red', size: 3 });
        expect(response.status).toBe(400);
        expect(response.body.details).toContainEqual({
          path: 'colour',
          message: 'is not a recognised field',
        });
        expect(response.body.details).toContainEqual({
          path: 'size',
          message: 'is not a recognised field',
        });
      });

      it('stays lenient about unknown query parameters', async () => {
        const response = await api.get(`/${path}`, { colour: 'red', page: 1 });
        expect(response.status).toBe(200);
      });

      it.each([
        ['a missing name', {}],
        ['a blank name', { name: '   ' }],
        ['a name over 200 characters', { name: 'x'.repeat(201) }],
        ['a name that is not text', { name: 5 }],
        ['a parentId that is not a UUID', { name: 'North', parentId: 'top' }],
      ])('rejects %s (400) and stores nothing', async (_name, body) => {
        const response = await api.post(`/${path}`, body);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('validation_failed');
        expect(response.body.details.length).toBeGreaterThan(0);
        expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
      });

      it('updates only the fields that are sent; null clears a field', async () => {
        const record = await make({ name: 'North' });
        await api.patch(`/${path}/${record.id}`, { description: 'First' });

        const renamed = await api.patch(`/${path}/${record.id}`, { name: 'North Yard' });
        expect(renamed.status).toBe(200);
        expect(renamed.body).toMatchObject({ name: 'North Yard', description: 'First' });

        const cleared = await api.patch(`/${path}/${record.id}`, { description: null });
        expect(cleared.body).toMatchObject({ name: 'North Yard', description: null });
        expect(new Date(cleared.body.updatedAt).getTime()).toBeGreaterThanOrEqual(
          new Date(renamed.body.updatedAt).getTime(),
        );
      });

      it('answers 404 for an id that names nothing, on read, update, archive and restore', async () => {
        const id = unknownId();
        const responses = await Promise.all([
          api.get(`/${path}/${id}`),
          api.patch(`/${path}/${id}`, { name: 'x' }),
          api.post(`/${path}/${id}/archive`),
          api.post(`/${path}/${id}/restore`),
        ]);
        for (const response of responses) {
          expect(response.status).toBe(404);
          expect(response.body.message).toBe(`${label} ${id} was not found`);
        }
      });
    });

    describe('parent validation', () => {
      it('accepts an active parent of the same organization, on create and on update', async () => {
        const parent = await make({ name: 'Parent' });
        const child = await api.post(`/${path}`, { name: 'Child', parentId: parent.id });
        expect(child.status).toBe(201);
        expect(child.body.parentId).toBe(parent.id);

        const orphan = await make({ name: 'Orphan' });
        const moved = await api.patch(`/${path}/${orphan.id}`, { parentId: parent.id });
        expect(moved.status).toBe(200);
        expect(moved.body.parentId).toBe(parent.id);

        const detached = await api.patch(`/${path}/${orphan.id}`, { parentId: null });
        expect(detached.body.parentId).toBeNull();
      });

      it('rejects a record as its own parent (422)', async () => {
        const record = await make();
        const response = await api.patch(`/${path}/${record.id}`, { parentId: record.id });
        expect(response.status).toBe(422);
        expect(response.body).toMatchObject({
          code: 'unprocessable',
          message: `${label} cannot be its own parent`,
          details: [{ path: 'parentId', message: 'must be a different record' }],
        });
      });

      it('rejects a direct cycle (422): a parent moved under its child', async () => {
        const parent = await make({ name: 'Parent' });
        const child = await make({ name: 'Child', parentId: parent.id });

        const response = await api.patch(`/${path}/${parent.id}`, { parentId: child.id });

        expect(response.status).toBe(422);
        expect(response.body.details).toEqual([
          { path: 'parentId', message: 'would create a cycle' },
        ]);
      });

      it('rejects a cycle several levels deep (422) and leaves the tree as it was', async () => {
        const top = await make({ name: 'Top' });
        const middle = await make({ name: 'Middle', parentId: top.id });
        const bottom = await make({ name: 'Bottom', parentId: middle.id });
        const leaf = await make({ name: 'Leaf', parentId: bottom.id });

        const response = await api.patch(`/${path}/${top.id}`, { parentId: leaf.id });

        expect(response.status).toBe(422);
        expect(response.body.message).toBe(
          `${label} cannot be moved below one of its own descendants`,
        );
        expect((await api.get(`/${path}/${top.id}`)).body.parentId).toBeNull();
        expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
      });

      it('allows a move that is not a cycle: to a sibling branch, and up the tree', async () => {
        const top = await make({ name: 'Top' });
        const left = await make({ name: 'Left', parentId: top.id });
        const right = await make({ name: 'Right', parentId: top.id });
        const leaf = await make({ name: 'Leaf', parentId: left.id });

        expect((await api.patch(`/${path}/${leaf.id}`, { parentId: right.id })).status).toBe(200);
        expect((await api.patch(`/${path}/${leaf.id}`, { parentId: top.id })).status).toBe(200);
        expect((await api.patch(`/${path}/${left.id}`, { parentId: leaf.id })).status).toBe(200);
      });

      it('rejects a parent of another organization (422), on create and on update', async () => {
        const foreign = await create(ctx.prisma, other.organization.id, { name: 'Foreign' });
        const record = await make();

        const created = await api.post(`/${path}`, { name: 'Child', parentId: foreign.id });
        const moved = await api.patch(`/${path}/${record.id}`, { parentId: foreign.id });

        for (const response of [created, moved]) {
          expect(response.status).toBe(422);
          expect(response.body.details).toEqual([
            {
              path: 'parentId',
              message: `${label} ${foreign.id} does not exist in this organization or is archived`,
            },
          ]);
        }
        expect(await countRows()).toBe(2);
      });

      it('rejects a parent that is archived or does not exist (422)', async () => {
        const archived = await make({ name: 'Closed', archivedAt: at() });
        expect((await api.post(`/${path}`, { name: 'A', parentId: archived.id })).status).toBe(422);
        expect((await api.post(`/${path}`, { name: 'B', parentId: unknownId() })).status).toBe(422);
      });
    });

    describe('archive and restore', () => {
      it('archives (sets archivedAt), hides the record from the default list, and restores it', async () => {
        const record = await make({ name: 'North' });

        const archived = await api.post(`/${path}/${record.id}/archive`);
        expect(archived.status).toBe(200);
        expect(new Date(archived.body.archivedAt).getTime()).toBeGreaterThan(at().getTime());
        expect(names(await api.get(`/${path}`))).toEqual([]);
        expect(names(await api.get(`/${path}`, { includeArchived: true }))).toEqual(['North']);
        // Still readable by id: history stays intact.
        expect((await api.get(`/${path}/${record.id}`)).body.archivedAt).toBe(
          archived.body.archivedAt,
        );

        const restored = await api.post(`/${path}/${record.id}/restore`);
        expect(restored.status).toBe(200);
        expect(restored.body.archivedAt).toBeNull();
        expect(names(await api.get(`/${path}`))).toEqual(['North']);
      });

      it('rejects an update of an archived record (409) until it is restored', async () => {
        const record = await make({ name: 'North', archivedAt: at() });

        const refused = await api.patch(`/${path}/${record.id}`, { name: 'Renamed' });
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({
          code: 'conflict',
          message: `${label} ${record.id} is archived; restore it before changing it`,
        });
        expect((await api.get(`/${path}/${record.id}`)).body.name).toBe('North');

        await api.post(`/${path}/${record.id}/restore`);
        expect((await api.patch(`/${path}/${record.id}`, { name: 'Renamed' })).status).toBe(200);
      });

      it('never deletes: the row, its children and its memberships survive archiving', async () => {
        const parent = await make({ name: 'Parent' });
        const child = await make({ name: 'Child', parentId: parent.id });
        const worker = await createUser(ctx.prisma, orgId());
        await createMembership(ctx.prisma, orgId(), worker.id, 'worker', {
          [path === 'sites' ? 'siteIds' : 'teamIds']: [parent.id],
        });

        await api.post(`/${path}/${parent.id}/archive`);

        expect((await api.get(`/${path}/${child.id}`)).body).toMatchObject({
          parentId: parent.id,
          archivedAt: null,
        });
        const memberships = await api.get('/memberships', { userId: worker.id });
        expect(memberships.body.total).toBe(1);
        expect(await countRows()).toBe(2);
      });
    });

    describe('list', () => {
      it('returns the pagination envelope, sorted by name by default', async () => {
        await Promise.all(['Charlie', 'alpha', 'Bravo'].map((name) => make({ name })));
        const response = await api.get(`/${path}`);
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ page: 1, pageSize: 25, total: 3 });
        expect([...names(response)].sort((x, y) => x.localeCompare(y))).toEqual([
          'alpha',
          'Bravo',
          'Charlie',
        ]);
        expect(names(await api.get(`/${path}`, { sort: 'name:desc' }))).toEqual(
          [...names(response)].reverse(),
        );
      });

      it('filters by search (case-insensitive) and by parent', async () => {
        const parent = await make({ name: 'North Depot' });
        await make({ name: 'North Yard', parentId: parent.id });
        await make({ name: 'South Depot' });

        expect(names(await api.get(`/${path}`, { search: 'north', sort: 'name:asc' }))).toEqual([
          'North Depot',
          'North Yard',
        ]);
        expect(names(await api.get(`/${path}`, { parentId: parent.id }))).toEqual(['North Yard']);
        expect(names(await api.get(`/${path}`, { search: 'nothing-like-this' }))).toEqual([]);
      });

      it('treats %, _ and \\ in a search term as plain characters, not as wildcards', async () => {
        await make({ name: 'North Depot' });
        await make({ name: '100% done' });
        await make({ name: 'snake_case' });
        await make({ name: 'back\\slash' });

        expect(names(await api.get(`/${path}`, { search: '%' }))).toEqual(['100% done']);
        expect(names(await api.get(`/${path}`, { search: '_' }))).toEqual(['snake_case']);
        expect(names(await api.get(`/${path}`, { search: '\\' }))).toEqual(['back\\slash']);
        expect(names(await api.get(`/${path}`, { search: 'N_rth' }))).toEqual([]);
        expect(names(await api.get(`/${path}`, { search: '0% D' }))).toEqual(['100% done']);
        expect(names(await api.get(`/${path}`, { search: 'e_c' }))).toEqual(['snake_case']);
      });

      it('pages through the records without repeating or skipping one', async () => {
        for (const name of ['A', 'B', 'C', 'D', 'E']) {
          await make({ name });
        }
        const pages = await Promise.all(
          [1, 2, 3, 4].map((page) => api.get(`/${path}`, { page, pageSize: 2, sort: 'name:asc' })),
        );
        expect(pages.map(names)).toEqual([['A', 'B'], ['C', 'D'], ['E'], []]);
        for (const [index, page] of pages.entries()) {
          expect(page.body).toMatchObject({ page: index + 1, pageSize: 2, total: 5 });
        }
      });

      it.each([
        ['page 0', { page: 0 }],
        ['page size 0', { pageSize: 0 }],
        ['page size 101', { pageSize: 101 }],
        ['an unknown sort field', { sort: 'organizationId:asc' }],
        ['an unknown sort direction', { sort: 'name:down' }],
        ['a parentId that is not a UUID', { parentId: 'root' }],
        ['includeArchived that is not true or false', { includeArchived: 'yes' }],
      ])('rejects %s (400)', async (_name, query) => {
        const response = await api.get(`/${path}`, query);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('validation_failed');
      });

      it('accepts the largest page size', async () => {
        expect((await api.get(`/${path}`, { pageSize: 100 })).body.pageSize).toBe(100);
      });
    });
  });

  describe('sites only', () => {
    it('stores code, address and coordinates', async () => {
      const response = await api.post('/sites', {
        name: 'North',
        code: 'N-01',
        address: 'Dock 4',
        latitude: 41.0082,
        longitude: 28.9784,
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        code: 'N-01',
        address: 'Dock 4',
        latitude: 41.0082,
        longitude: 28.9784,
      });
    });

    it.each([
      ['latitude above 90', { latitude: 90.1 }],
      ['latitude below -90', { latitude: -90.1 }],
      ['longitude above 180', { longitude: 180.1 }],
      ['a latitude sent as text', { latitude: '41' }],
      ['an empty code', { code: '' }],
    ])('rejects %s (400)', async (_name, extra) => {
      expect((await api.post('/sites', { name: 'North', ...extra })).status).toBe(400);
    });

    it('rejects a code already used in the organization (409), on create and on update', async () => {
      await createSite(ctx.prisma, orgId(), { code: 'N-01' });
      const second = await createSite(ctx.prisma, orgId(), { code: 'N-02' });

      const created = await api.post('/sites', { name: 'Clash', code: 'N-01' });
      const updated = await api.patch(`/sites/${second.id}`, { code: 'N-01' });

      for (const response of [created, updated]) {
        expect(response.status).toBe(409);
        expect(response.body.code).toBe('conflict');
      }
      expect(await ctx.prisma.site.count()).toBe(2);
    });

    it('allows the same code in another organization, and many sites without a code', async () => {
      await createSite(ctx.prisma, other.organization.id, { code: 'N-01' });
      expect((await api.post('/sites', { name: 'Mine', code: 'N-01' })).status).toBe(201);
      expect((await api.post('/sites', { name: 'No code 1' })).status).toBe(201);
      expect((await api.post('/sites', { name: 'No code 2' })).status).toBe(201);
    });

    it('searches the code as well as the name', async () => {
      await createSite(ctx.prisma, orgId(), { name: 'North', code: 'ZX-77' });
      await createSite(ctx.prisma, orgId(), { name: 'South', code: 'S-01' });
      expect(names(await api.get('/sites', { search: 'zx' }))).toEqual(['North']);
    });
  });

  describe('users', () => {
    it('creates a user with a lower-cased email and no memberships', async () => {
      const response = await api.post('/users', {
        email: '  New.Person@Example.TEST ',
        displayName: 'New Person',
        phone: '+90 555 000 00 00',
      });
      expect(response.status).toBe(201);
      expect(userSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        organizationId: orgId(),
        email: 'new.person@example.test',
        displayName: 'New Person',
        phone: '+90 555 000 00 00',
        memberships: [],
        archivedAt: null,
      });
    });

    it('rejects an email already used in the organization, whatever its case (409)', async () => {
      await createUser(ctx.prisma, orgId(), { email: 'taken@example.test' });
      const second = await createUser(ctx.prisma, orgId());

      const created = await api.post('/users', { email: 'TAKEN@example.test', displayName: 'X' });
      const updated = await api.patch(`/users/${second.id}`, { email: 'taken@example.test' });

      for (const response of [created, updated]) {
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
          code: 'conflict',
          details: [{ path: 'email', message: 'is already in use' }],
        });
      }
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('allows the same email in another organization', async () => {
      await createUser(ctx.prisma, other.organization.id, { email: 'shared@example.test' });
      const response = await api.post('/users', { email: 'shared@example.test', displayName: 'X' });
      expect(response.status).toBe(201);
    });

    it.each([
      ['an email without a domain', { email: 'nobody', displayName: 'X' }],
      ['a missing display name', { email: 'a@example.test' }],
      ['an empty phone', { email: 'a@example.test', displayName: 'X', phone: '' }],
    ])('rejects %s (400)', async (_name, body) => {
      expect((await api.post('/users', body)).status).toBe(400);
    });

    it('embeds the active memberships of a user, and drops archived ones', async () => {
      const site = await createSite(ctx.prisma, orgId());
      const team = await createTeam(ctx.prisma, orgId());
      const user = await createUser(ctx.prisma, orgId());
      const active = await createMembership(ctx.prisma, orgId(), user.id, 'supervisor', {
        siteIds: [site.id],
        teamIds: [team.id],
      });
      await createMembership(ctx.prisma, orgId(), user.id, 'admin', {
        orgWide: true,
        archivedAt: at(),
      });

      const response = await api.get(`/users/${user.id}`);

      expect(response.body.memberships).toEqual([
        {
          id: active.id,
          role: 'supervisor',
          orgWide: false,
          siteIds: [site.id],
          teamIds: [team.id],
        },
      ]);
    });

    it('archives and restores a user, keeping their memberships', async () => {
      const user = await createUser(ctx.prisma, orgId(), { displayName: 'Leaver' });
      await createMembership(ctx.prisma, orgId(), user.id, 'worker');

      const archived = await api.post(`/users/${user.id}/archive`);
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();
      const listed = await api.get('/users', { search: 'Leaver' });
      expect(listed.body.total).toBe(0);
      expect(
        (await api.get('/users', { search: 'Leaver', includeArchived: true })).body.total,
      ).toBe(1);

      const refused = await api.patch(`/users/${user.id}`, { displayName: 'Changed' });
      expect(refused.status).toBe(409);

      const restored = await api.post(`/users/${user.id}/restore`);
      expect(restored.body.archivedAt).toBeNull();
      expect(restored.body.memberships).toHaveLength(1);
    });

    it('filters users by role, site and team of one active membership, and by search', async () => {
      const [site, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const [siteWorker, teamWorker, siteSupervisor, formerSiteWorker] = await Promise.all([
        createUser(ctx.prisma, orgId(), { displayName: 'Site Worker' }),
        createUser(ctx.prisma, orgId(), { displayName: 'Team Worker' }),
        createUser(ctx.prisma, orgId(), { displayName: 'Site Supervisor' }),
        createUser(ctx.prisma, orgId(), { displayName: 'Former Site Worker' }),
      ]);
      await createMembership(ctx.prisma, orgId(), siteWorker.id, 'worker', { siteIds: [site.id] });
      await createMembership(ctx.prisma, orgId(), teamWorker.id, 'worker', { teamIds: [team.id] });
      await createMembership(ctx.prisma, orgId(), siteSupervisor.id, 'supervisor', {
        siteIds: [site.id],
      });
      await createMembership(ctx.prisma, orgId(), formerSiteWorker.id, 'worker', {
        siteIds: [site.id],
        archivedAt: at(),
      });
      const displayNames = async (query: Record<string, string>) =>
        ((await api.get('/users', { ...query, sort: 'displayName:asc' })).body.items as Json[]).map(
          (item) => item.displayName,
        );

      expect(await displayNames({ siteId: site.id })).toEqual(['Site Supervisor', 'Site Worker']);
      expect(await displayNames({ siteId: site.id, role: 'worker' })).toEqual(['Site Worker']);
      expect(await displayNames({ teamId: team.id })).toEqual(['Team Worker']);
      expect(await displayNames({ role: 'supervisor' })).toEqual(['Site Supervisor']);
      expect(await displayNames({ role: 'admin' })).toEqual(['Admin']);
      // One membership must match site AND team together: nobody has both here.
      expect(await displayNames({ siteId: site.id, teamId: team.id })).toEqual([]);
      expect(await displayNames({ search: 'SUPERVISOR' })).toEqual(['Site Supervisor']);
      expect(await displayNames({ role: 'manager' })).toEqual([]);
    });
  });

  describe('memberships', () => {
    it('creates a membership scoped to a site and a team together (201)', async () => {
      const [siteA, siteB, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const user = await createUser(ctx.prisma, orgId());

      const response = await api.post('/memberships', {
        userId: user.id,
        role: 'supervisor',
        siteIds: [siteB.id, siteA.id],
        teamIds: [team.id],
      });

      expect(response.status).toBe(201);
      expect(membershipSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        organizationId: orgId(),
        userId: user.id,
        role: 'supervisor',
        orgWide: false,
        siteIds: [siteA.id, siteB.id].sort(),
        teamIds: [team.id],
        archivedAt: null,
      });
      const stored = await ctx.prisma.membershipSite.findMany({
        where: { membershipId: response.body.id },
      });
      expect(stored).toHaveLength(2);
      expect(stored.every((row) => row.organizationId === orgId())).toBe(true);
    });

    it('lets one person hold several memberships with different roles and scopes', async () => {
      const [site, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const user = await createUser(ctx.prisma, orgId());

      const worker = await api.post('/memberships', {
        userId: user.id,
        role: 'worker',
        teamIds: [team.id],
      });
      const supervisor = await api.post('/memberships', {
        userId: user.id,
        role: 'supervisor',
        siteIds: [site.id],
      });
      const manager = await api.post('/memberships', {
        userId: user.id,
        role: 'manager',
        orgWide: true,
      });

      expect([worker.status, supervisor.status, manager.status]).toEqual([201, 201, 201]);
      const listed = await api.get('/memberships', { userId: user.id });
      expect((listed.body.items as Json[]).map((item) => item.role)).toEqual([
        'worker',
        'supervisor',
        'manager',
      ]);
      expect((await api.get(`/users/${user.id}`)).body.memberships).toHaveLength(3);
    });

    it('rejects references to another organization (422), one detail per bad id', async () => {
      const [site, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const [foreignSite, foreignTeam, foreignUser] = await Promise.all([
        createSite(ctx.prisma, other.organization.id),
        createTeam(ctx.prisma, other.organization.id),
        createUser(ctx.prisma, other.organization.id),
      ]);

      const response = await api.post('/memberships', {
        userId: foreignUser.id,
        role: 'worker',
        siteIds: [site.id, foreignSite.id],
        teamIds: [foreignTeam.id, team.id],
      });

      expect(response.status).toBe(422);
      expect((response.body.details as Json[]).map((detail) => detail.path).sort()).toEqual([
        'siteIds.1',
        'teamIds.0',
        'userId',
      ]);
      expect(await ctx.prisma.membership.count({ where: { userId: foreignUser.id } })).toBe(0);
      expect(await ctx.prisma.membershipSite.count()).toBe(0);
    });

    it('rejects references to archived records (422)', async () => {
      const [archivedSite, archivedTeam] = await Promise.all([
        createSite(ctx.prisma, orgId(), { archivedAt: at() }),
        createTeam(ctx.prisma, orgId(), { archivedAt: at() }),
      ]);
      const [user, archivedUser] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId(), { archivedAt: at() }),
      ]);

      const bySite = await api.post('/memberships', {
        userId: user.id,
        role: 'worker',
        siteIds: [archivedSite.id],
      });
      const byTeam = await api.post('/memberships', {
        userId: user.id,
        role: 'worker',
        teamIds: [archivedTeam.id],
      });
      const byUser = await api.post('/memberships', { userId: archivedUser.id, role: 'worker' });

      expect(bySite.status).toBe(422);
      expect(bySite.body.details[0].path).toBe('siteIds.0');
      expect(byTeam.status).toBe(422);
      expect(byTeam.body.details[0].path).toBe('teamIds.0');
      expect(byUser.status).toBe(422);
      expect(byUser.body.details[0].path).toBe('userId');
      expect(await ctx.prisma.membership.count({ where: { role: 'worker' } })).toBe(0);
    });

    it.each([
      ['an unknown role', { role: 'owner' }],
      ['a missing role', { role: undefined }],
      ['a duplicate site id', { role: 'worker', siteIds: 'DUPLICATE' }],
      ['orgWide that is not a boolean', { role: 'worker', orgWide: 'true' }],
      ['a missing user', { role: 'worker', userId: undefined }],
    ])('rejects %s (400)', async (_name, extra) => {
      const site = await createSite(ctx.prisma, orgId());
      const user = await createUser(ctx.prisma, orgId());
      const body = { userId: user.id, ...extra } as Record<string, unknown>;
      if (body.siteIds === 'DUPLICATE') {
        body.siteIds = [site.id, site.id];
      }
      const response = await api.post('/memberships', body);
      expect(response.status).toBe(400);
      expect(await ctx.prisma.membership.count({ where: { userId: user.id } })).toBe(0);
    });

    it('updates the role and replaces the scope lists that are sent, keeping the others', async () => {
      const [siteA, siteB, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const user = await createUser(ctx.prisma, orgId());
      const membership = await createMembership(ctx.prisma, orgId(), user.id, 'worker', {
        siteIds: [siteA.id],
        teamIds: [team.id],
      });

      const sitesOnly = await api.patch(`/memberships/${membership.id}`, { siteIds: [siteB.id] });
      expect(sitesOnly.status).toBe(200);
      expect(sitesOnly.body).toMatchObject({
        role: 'worker',
        siteIds: [siteB.id],
        teamIds: [team.id],
      });

      const promoted = await api.patch(`/memberships/${membership.id}`, {
        role: 'supervisor',
        teamIds: [],
      });
      expect(promoted.body).toMatchObject({
        role: 'supervisor',
        siteIds: [siteB.id],
        teamIds: [],
      });

      const wide = await api.patch(`/memberships/${membership.id}`, { orgWide: true });
      expect(wide.body).toMatchObject({ orgWide: true, role: 'supervisor', siteIds: [siteB.id] });
    });

    it('rejects an update that points at another organization or an archived record (422)', async () => {
      const foreignSite = await createSite(ctx.prisma, other.organization.id);
      const archivedTeam = await createTeam(ctx.prisma, orgId(), { archivedAt: at() });
      const site = await createSite(ctx.prisma, orgId());
      const user = await createUser(ctx.prisma, orgId());
      const membership = await createMembership(ctx.prisma, orgId(), user.id, 'worker', {
        siteIds: [site.id],
      });

      const response = await api.patch(`/memberships/${membership.id}`, {
        siteIds: [foreignSite.id],
        teamIds: [archivedTeam.id],
      });

      expect(response.status).toBe(422);
      expect((response.body.details as Json[]).map((detail) => detail.path).sort()).toEqual([
        'siteIds.0',
        'teamIds.0',
      ]);
      expect((await api.get(`/memberships/${membership.id}`)).body.siteIds).toEqual([site.id]);
    });

    it('archives a membership, hides it from the default list and refuses later changes (409)', async () => {
      const user = await createUser(ctx.prisma, orgId());
      const membership = await createMembership(ctx.prisma, orgId(), user.id, 'worker');

      const archived = await api.post(`/memberships/${membership.id}/archive`);
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();
      expect((await api.get('/memberships', { userId: user.id })).body.total).toBe(0);
      expect(
        (await api.get('/memberships', { userId: user.id, includeArchived: true })).body.total,
      ).toBe(1);
      expect((await api.get(`/users/${user.id}`)).body.memberships).toEqual([]);

      const refused = await api.patch(`/memberships/${membership.id}`, { role: 'admin' });
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('conflict');
    });

    it('filters memberships by user, role, site and team', async () => {
      const [site, team] = await Promise.all([
        createSite(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const [one, two] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      const atSite = await createMembership(ctx.prisma, orgId(), one.id, 'worker', {
        siteIds: [site.id],
      });
      const atTeam = await createMembership(ctx.prisma, orgId(), two.id, 'supervisor', {
        teamIds: [team.id],
      });
      const ids = async (query: Record<string, string>) =>
        ((await api.get('/memberships', query)).body.items as Json[]).map((item) => item.id);

      expect(await ids({ userId: one.id })).toEqual([atSite.id]);
      expect(await ids({ role: 'supervisor' })).toEqual([atTeam.id]);
      expect(await ids({ siteId: site.id })).toEqual([atSite.id]);
      expect(await ids({ teamId: team.id })).toEqual([atTeam.id]);
      expect(await ids({ siteId: site.id, role: 'supervisor' })).toEqual([]);
      expect((await api.get('/memberships', { role: 'boss' })).status).toBe(400);
    });
  });

  describe('scope endpoints (inspection only in this phase)', () => {
    it('resolves a site+team supervisor from the database: union, descendants, colleagues', async () => {
      const north = await createSite(ctx.prisma, orgId(), { name: 'North' });
      const yard = await createSite(ctx.prisma, orgId(), { name: 'Yard', parentId: north.id });
      const south = await createSite(ctx.prisma, orgId(), { name: 'South' });
      const electrical = await createTeam(ctx.prisma, orgId(), { name: 'Electrical' });
      const night = await createTeam(ctx.prisma, orgId(), {
        name: 'Night',
        parentId: electrical.id,
      });
      const [supervisor, yardWorker, nightWorker, southWorker] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      await createMembership(ctx.prisma, orgId(), supervisor.id, 'supervisor', {
        siteIds: [north.id],
        teamIds: [electrical.id],
      });
      await createMembership(ctx.prisma, orgId(), yardWorker.id, 'worker', { siteIds: [yard.id] });
      await createMembership(ctx.prisma, orgId(), nightWorker.id, 'worker', {
        teamIds: [night.id],
      });
      await createMembership(ctx.prisma, orgId(), southWorker.id, 'worker', {
        siteIds: [south.id],
      });

      const response = await ctx.as(supervisor.id).get('/scope/me');

      expect(response.status).toBe(200);
      expect(resolvedScopeSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toEqual({
        userId: supervisor.id,
        organizationId: orgId(),
        active: true,
        roles: ['supervisor'],
        orgWide: false,
        siteIds: [north.id, yard.id].sort(),
        teamIds: [electrical.id, night.id].sort(),
        userIds: [supervisor.id, yardWorker.id, nightWorker.id].sort(),
        memberOf: { orgWide: false, siteIds: [], teamIds: [] },
      });
      expect(response.body.siteIds).not.toContain(south.id);
      expect(response.body.userIds).not.toContain(southWorker.id);
      expect(response.body.userIds).not.toContain(tenant.admin.id);
    });

    it('resolves a worker in two teams: own records only, member of both teams', async () => {
      const [teamA, teamB] = await Promise.all([
        createTeam(ctx.prisma, orgId()),
        createTeam(ctx.prisma, orgId()),
      ]);
      const [worker, mate] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      await createMembership(ctx.prisma, orgId(), worker.id, 'worker', {
        teamIds: [teamA.id, teamB.id],
      });
      await createMembership(ctx.prisma, orgId(), mate.id, 'worker', { teamIds: [teamA.id] });

      const response = await api.get(`/users/${worker.id}/scope`);

      expect(response.body).toMatchObject({
        roles: ['worker'],
        orgWide: false,
        siteIds: [],
        teamIds: [],
        userIds: [worker.id],
        memberOf: { orgWide: false, siteIds: [], teamIds: [teamA.id, teamB.id].sort() },
      });
    });

    it('gives an organization-wide admin everything of their own organization only', async () => {
      const site = await createSite(ctx.prisma, orgId());
      const foreignSite = await createSite(ctx.prisma, other.organization.id);

      const response = await api.get('/scope/me');

      expect(response.body).toMatchObject({
        roles: ['admin'],
        orgWide: true,
        userIds: 'all',
        siteIds: [site.id],
        teamIds: [],
      });
      expect(response.body.siteIds).not.toContain(foreignSite.id);
    });

    it('ignores archived memberships and reports an archived user as inactive', async () => {
      const site = await createSite(ctx.prisma, orgId());
      const user = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), user.id, 'supervisor', {
        siteIds: [site.id],
        archivedAt: at(),
      });

      const formerSupervisor = await api.get(`/users/${user.id}/scope`);
      expect(formerSupervisor.body).toMatchObject({
        active: true,
        roles: [],
        siteIds: [],
        userIds: [user.id],
      });

      const admin = await createUser(ctx.prisma, orgId(), { archivedAt: at() });
      await createMembership(ctx.prisma, orgId(), admin.id, 'admin', { orgWide: true });
      const archivedAdmin = await api.get(`/users/${admin.id}/scope`);
      expect(archivedAdmin.status).toBe(200);
      expect(archivedAdmin.body).toMatchObject({
        active: false,
        roles: [],
        orgWide: false,
        siteIds: [],
        userIds: [admin.id],
      });
    });

    it('shows a child-site supervisor the workers of the parent site, not the manager above', async () => {
      const region = await createSite(ctx.prisma, orgId(), { name: 'Region' });
      const city = await createSite(ctx.prisma, orgId(), { name: 'City', parentId: region.id });
      const depot = await createSite(ctx.prisma, orgId(), { name: 'Depot', parentId: city.id });
      const harbour = await createSite(ctx.prisma, orgId(), {
        name: 'Harbour',
        parentId: region.id,
      });
      const [supervisor, regionWorker, regionManager, citySupervisor, harbourWorker] =
        await Promise.all(Array.from({ length: 5 }, () => createUser(ctx.prisma, orgId())));
      const member = (userId: string, role: 'worker' | 'supervisor' | 'manager', siteId: string) =>
        createMembership(ctx.prisma, orgId(), userId, role, { siteIds: [siteId] });
      await member(supervisor!.id, 'supervisor', depot.id);
      await member(regionWorker!.id, 'worker', region.id);
      await member(regionManager!.id, 'manager', region.id);
      await member(citySupervisor!.id, 'supervisor', city.id);
      await member(harbourWorker!.id, 'worker', harbour.id);

      const response = await ctx.as(supervisor!.id).get('/scope/me');

      expect(response.body.siteIds).toEqual([depot.id]);
      expect(response.body.userIds).toEqual([supervisor!.id, regionWorker!.id].sort());
      for (const hidden of [regionManager!.id, citySupervisor!.id, harbourWorker!.id]) {
        expect(response.body.userIds).not.toContain(hidden);
      }
      // The region worker themselves still sees only their own records.
      expect((await ctx.as(regionWorker!.id).get('/scope/me')).body.userIds).toEqual([
        regionWorker!.id,
      ]);
    });

    it('as implemented: an archived site still counts as scope and passes it to its sub-sites', async () => {
      const closed = await createSite(ctx.prisma, orgId(), { name: 'Closed', archivedAt: at() });
      const annex = await createSite(ctx.prisma, orgId(), { name: 'Annex', parentId: closed.id });
      const [supervisor, annexWorker] = await Promise.all([
        createUser(ctx.prisma, orgId()),
        createUser(ctx.prisma, orgId()),
      ]);
      await createMembership(ctx.prisma, orgId(), supervisor.id, 'supervisor', {
        siteIds: [closed.id],
      });
      await createMembership(ctx.prisma, orgId(), annexWorker.id, 'worker', {
        siteIds: [annex.id],
      });

      const response = await api.get(`/users/${supervisor.id}/scope`);

      expect(response.body.siteIds).toEqual([closed.id, annex.id].sort());
      expect(response.body.userIds).toEqual([supervisor.id, annexWorker.id].sort());
    });

    it('answers 404 for a user that does not exist and 400 for a bad id', async () => {
      expect((await api.get(`/users/${unknownId()}/scope`)).status).toBe(404);
      expect((await api.get('/users/not-a-uuid/scope')).status).toBe(400);
    });

    it('does not enforce the scope yet: a worker can still list every site (Phase 3)', async () => {
      await createSite(ctx.prisma, orgId());
      const worker = await createUser(ctx.prisma, orgId());
      await createMembership(ctx.prisma, orgId(), worker.id, 'worker');
      expect((await ctx.as(worker.id).get('/scope/me')).body.siteIds).toEqual([]);
      expect((await ctx.as(worker.id).get('/sites')).body.total).toBe(1);
    });
  });
});
