import { randomUUID } from 'node:crypto';
import { logTypeSchema } from '@ops/shared';
import {
  at,
  createLogType,
  createTenant,
  eventCounts,
  INSPECTION_FIELDS,
  type Tenant,
} from './support/factories';
import { startTestApp, type ApiCaller, type Json, type TestApp } from './support/test-app';

// Log types are the client's way to add new kinds of input without code changes: a list of
// custom field definitions, versioned whenever it changes.

describe('log types', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  let api: ApiCaller;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    api = ctx.as(tenant.admin.id);
  });
  afterAll(() => ctx.close());

  const orgId = () => tenant.organization.id;
  const detailPaths = (response: { body: Json }) =>
    (response.body.details as Json[]).map((detail) => detail.path).sort();

  describe('create', () => {
    it('creates a log type with fields at version 1, filling in the defaults', async () => {
      const response = await api.post('/log-types', {
        key: 'material_usage',
        name: 'Material usage',
        description: 'What was used on site',
        fields: [
          { key: 'material', label: 'Material', type: 'select', options: ['Cement', 'Sand'] },
          { key: 'amount', label: 'Amount', type: 'number', required: true, helpText: 'In kg' },
          { key: 'delivered_on', label: 'Delivered on', type: 'date' },
          { key: 'checked', label: 'Checked', type: 'boolean' },
          { key: 'note', label: 'Note', type: 'text' },
        ],
      });

      expect(response.status).toBe(201);
      expect(logTypeSchema.safeParse(response.body).success).toBe(true);
      expect(response.body).toMatchObject({
        organizationId: orgId(),
        key: 'material_usage',
        name: 'Material usage',
        description: 'What was used on site',
        version: 1,
        archivedAt: null,
      });
      // Order is kept; `required` defaults to false.
      expect(response.body.fields).toEqual([
        {
          key: 'material',
          label: 'Material',
          type: 'select',
          required: false,
          options: ['Cement', 'Sand'],
        },
        { key: 'amount', label: 'Amount', type: 'number', required: true, helpText: 'In kg' },
        { key: 'delivered_on', label: 'Delivered on', type: 'date', required: false },
        { key: 'checked', label: 'Checked', type: 'boolean', required: false },
        { key: 'note', label: 'Note', type: 'text', required: false },
      ]);
      expect((await api.get(`/log-types/${response.body.id}`)).body).toEqual(response.body);
    });

    it('creates a log type without fields', async () => {
      const response = await api.post('/log-types', { key: 'note', name: 'Note' });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ fields: [], version: 1, description: null });
    });

    it('rejects broken field definitions (400), pointing at each one', async () => {
      const response = await api.post('/log-types', {
        key: 'broken',
        name: 'Broken',
        fields: [
          { key: 'ok', label: 'Fine', type: 'text' },
          { key: 'Bad Key', label: 'Bad key', type: 'text' },
          { key: 'choice', label: 'Select without options', type: 'select' },
          { key: 'amount', label: 'Number with options', type: 'number', options: ['1'] },
          { key: 'ok', label: 'Duplicate key', type: 'boolean' },
          { key: 'kind', label: 'Unknown type', type: 'colour' },
        ],
      });

      expect(response.status).toBe(400);
      expect(response.body.code).toBe('validation_failed');
      expect(detailPaths(response)).toEqual([
        'fields.1.key',
        'fields.2.options',
        'fields.3.options',
        'fields.5.type',
      ]);
      expect(await ctx.prisma.logType.count()).toBe(0);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('rejects duplicate field keys (400) at the later field', async () => {
      const response = await api.post('/log-types', {
        key: 'dupes',
        name: 'Dupes',
        fields: [
          { key: 'area', label: 'Area', type: 'text' },
          { key: 'area', label: 'Area again', type: 'number' },
        ],
      });
      expect(response.status).toBe(400);
      expect(response.body.details).toEqual([
        { path: 'fields.1.key', message: 'Duplicate field key "area"' },
      ]);
    });

    it.each([
      [
        'a select with duplicate options',
        [{ key: 'a', label: 'A', type: 'select', options: ['x', 'x'] }],
      ],
      [
        'a select with an empty option list',
        [{ key: 'a', label: 'A', type: 'select', options: [] }],
      ],
      ['a field without a label', [{ key: 'a', type: 'text' }]],
      [
        'a field with "required" sent as text',
        [{ key: 'a', label: 'A', type: 'text', required: 'yes' }],
      ],
      ['fields that are not a list', { key: 'a', label: 'A', type: 'text' }],
    ])('rejects %s (400)', async (_name, fields) => {
      const response = await api.post('/log-types', { key: 'bad', name: 'Bad', fields });
      expect(response.status).toBe(400);
      expect(detailPaths(response).every((path: string) => path.startsWith('fields'))).toBe(true);
    });

    it.each([
      ['upper case', 'Inspection'],
      ['a hyphen', 'site-inspection'],
      ['a leading digit', '1inspection'],
      ['a space', 'site inspection'],
      ['nothing', ''],
    ])('rejects a key with %s (400)', async (_name, key) => {
      const response = await api.post('/log-types', { key, name: 'Inspection' });
      expect(response.status).toBe(400);
      expect(detailPaths(response)).toEqual(['key']);
    });

    it('rejects a key already used in the organization (409)', async () => {
      await createLogType(ctx.prisma, orgId(), { key: 'inspection' });
      const response = await api.post('/log-types', { key: 'inspection', name: 'Second' });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'conflict',
        message: 'A log type with key "inspection" already exists',
        details: [{ path: 'key', message: 'is already in use' }],
      });
      expect(await ctx.prisma.logType.count()).toBe(1);
    });

    it('rejects the key of an archived log type too (409): keys are never reused', async () => {
      await createLogType(ctx.prisma, orgId(), { key: 'inspection', archivedAt: at() });
      expect((await api.post('/log-types', { key: 'inspection', name: 'Again' })).status).toBe(409);
    });

    it('allows the same key in another organization', async () => {
      const other = await createTenant(ctx.prisma);
      await createLogType(ctx.prisma, other.organization.id, { key: 'inspection' });
      expect((await api.post('/log-types', { key: 'inspection', name: 'Mine' })).status).toBe(201);
    });
  });

  describe('version', () => {
    async function createInspection(): Promise<Json> {
      const response = await api.post('/log-types', {
        key: 'inspection',
        name: 'Inspection',
        fields: INSPECTION_FIELDS,
      });
      expect(response.status).toBe(201);
      return response.body;
    }

    it('stays the same when only the name or the description changes', async () => {
      const logType = await createInspection();

      const renamed = await api.patch(`/log-types/${logType.id}`, { name: 'Site inspection' });
      const described = await api.patch(`/log-types/${logType.id}`, { description: 'Weekly' });

      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({ name: 'Site inspection', version: 1 });
      expect(described.body).toMatchObject({
        name: 'Site inspection',
        description: 'Weekly',
        version: 1,
      });
      expect(described.body.fields).toEqual(logType.fields);
    });

    it('stays the same when the same fields are sent again', async () => {
      const logType = await createInspection();

      const asStored = await api.patch(`/log-types/${logType.id}`, { fields: logType.fields });
      // The input form: `required` left out where it is false, as the client first sent it.
      const asFirstSent = await api.patch(`/log-types/${logType.id}`, {
        name: 'Inspection',
        fields: INSPECTION_FIELDS,
      });

      expect(asStored.body.version).toBe(1);
      expect(asFirstSent.body.version).toBe(1);
    });

    it('goes up by one each time the fields really change', async () => {
      const logType = await createInspection();

      const added = await api.patch(`/log-types/${logType.id}`, {
        fields: [...INSPECTION_FIELDS, { key: 'inspector', label: 'Inspector', type: 'text' }],
      });
      expect(added.status).toBe(200);
      expect(added.body.version).toBe(2);
      expect(added.body.fields).toHaveLength(6);

      const relabelled = await api.patch(`/log-types/${logType.id}`, {
        fields: added.body.fields.map((field: Json) =>
          field.key === 'area' ? { ...field, label: 'Zone' } : field,
        ),
      });
      expect(relabelled.body.version).toBe(3);

      const madeOptional = await api.patch(`/log-types/${logType.id}`, {
        fields: relabelled.body.fields.map((field: Json) => ({ ...field, required: false })),
      });
      expect(madeOptional.body.version).toBe(4);

      const emptied = await api.patch(`/log-types/${logType.id}`, { fields: [] });
      expect(emptied.body).toMatchObject({ version: 5, fields: [] });
      expect((await api.get(`/log-types/${logType.id}`)).body.version).toBe(5);
    });

    it('goes up when the options of a select or the order of the fields change', async () => {
      const logType = await createInspection();

      const moreOptions = await api.patch(`/log-types/${logType.id}`, {
        fields: logType.fields.map((field: Json) =>
          field.key === 'result' ? { ...field, options: ['ok', 'defect', 'n/a'] } : field,
        ),
      });
      expect(moreOptions.body.version).toBe(2);

      const reordered = await api.patch(`/log-types/${logType.id}`, {
        fields: [...moreOptions.body.fields].reverse(),
      });
      expect(reordered.body.version).toBe(3);
      expect(reordered.body.fields[0].key).toBe('next_check');
    });

    it('does not move when an update is rejected', async () => {
      const logType = await createInspection();
      const response = await api.patch(`/log-types/${logType.id}`, {
        fields: [{ key: 'choice', label: 'Choice', type: 'select' }],
      });
      expect(response.status).toBe(400);
      expect(detailPaths(response)).toEqual(['fields.0.options']);
      expect((await api.get(`/log-types/${logType.id}`)).body).toEqual(logType);
    });

    it('is recorded on each work log: old logs keep theirs, new logs get the current one', async () => {
      const logType = await createInspection();
      const log = (customFields: Record<string, unknown>) =>
        api.post('/work-logs', {
          clientId: randomUUID(),
          occurredAt: at().toISOString(),
          logTypeId: logType.id,
          customFields,
        });

      const before = await log({ area: 'Roof', quantity: 1 });
      expect(before.body.logTypeVersion).toBe(1);

      await api.patch(`/log-types/${logType.id}`, {
        fields: [
          ...INSPECTION_FIELDS,
          { key: 'inspector', label: 'Inspector', type: 'text', required: true },
        ],
      });

      // The new required field applies to new logs only.
      const withoutNewField = await log({ area: 'Roof', quantity: 1 });
      expect(withoutNewField.status).toBe(400);
      expect(detailPaths(withoutNewField)).toEqual(['customFields.inspector']);

      const after = await log({ area: 'Roof', quantity: 1, inspector: 'Demo Person' });
      expect(after.status).toBe(201);
      expect(after.body.logTypeVersion).toBe(2);
      expect((await api.get(`/work-logs/${before.body.id}`)).body).toMatchObject({
        logTypeVersion: 1,
        customFields: { area: 'Roof', quantity: 1 },
      });
    });

    it('emits log_type.updated with the version change in the audit diff', async () => {
      const logType = await createLogType(ctx.prisma, orgId(), { fields: [] });
      await api.patch(`/log-types/${logType.id}`, {
        fields: [{ key: 'area', label: 'Area', type: 'text' }],
      });
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow();
      expect(audit.action).toBe('log_type.updated');
      expect(audit.changes).toMatchObject({
        version: { from: 1, to: 2 },
        fields: { from: [], to: [{ key: 'area', label: 'Area', type: 'text', required: false }] },
      });
    });
  });

  describe('update, archive and list', () => {
    it('cannot change the key: an update that names it is rejected (400) and changes nothing', async () => {
      const logType = await createLogType(ctx.prisma, orgId(), { key: 'inspection' });

      const alone = await api.patch(`/log-types/${logType.id}`, { key: 'renamed' });
      const withName = await api.patch(`/log-types/${logType.id}`, { key: 'renamed', name: 'New' });
      const withVersion = await api.patch(`/log-types/${logType.id}`, { name: 'New', version: 9 });

      for (const [response, key] of [
        [alone, 'key'],
        [withName, 'key'],
        [withVersion, 'version'],
      ] as const) {
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('validation_failed');
        expect(response.body.details).toContainEqual({
          path: key,
          message: 'is not a recognised field',
        });
      }
      expect(await ctx.prisma.logType.findUniqueOrThrow({ where: { id: logType.id } })).toEqual(
        logType,
      );
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 0, outbox: 0 });
    });

    it('rejects an unknown key inside a field definition or in the create body (400)', async () => {
      const inField = await api.post('/log-types', {
        key: 'strict',
        name: 'Strict',
        fields: [{ key: 'a', label: 'A', type: 'text', placeholder: 'x' }],
      });
      const inBody = await api.post('/log-types', { key: 'strict', name: 'Strict', version: 5 });
      expect(inBody.status).toBe(400);
      expect(inBody.body.details).toEqual([
        { path: 'version', message: 'is not a recognised field' },
      ]);
      expect(inField.status).toBe(400);
      expect(inField.body.details).toEqual([
        { path: 'fields.0.placeholder', message: 'is not a recognised field' },
      ]);
      expect(await ctx.prisma.logType.count()).toBe(0);
    });

    it('rejects an unknown key inside a field definition of an update (400), at its index', async () => {
      const logType = await createLogType(ctx.prisma, orgId());
      const response = await api.patch(`/log-types/${logType.id}`, {
        fields: [
          { key: 'area', label: 'Area', type: 'text' },
          { key: 'amount', label: 'Amount', type: 'number', min: 0, max: 10 },
        ],
      });
      expect(response.status).toBe(400);
      expect(response.body.details).toEqual([
        { path: 'fields.1.min', message: 'is not a recognised field' },
        { path: 'fields.1.max', message: 'is not a recognised field' },
      ]);
      expect((await api.get(`/log-types/${logType.id}`)).body.version).toBe(1);
    });

    it('archives a log type, hides it from the default list and refuses changes (409)', async () => {
      const logType = await createLogType(ctx.prisma, orgId(), { name: 'Inspection' });

      const archived = await api.post(`/log-types/${logType.id}/archive`);
      expect(archived.status).toBe(200);
      expect(archived.body.archivedAt).not.toBeNull();
      expect((await api.get('/log-types')).body.total).toBe(0);
      expect((await api.get('/log-types', { includeArchived: true })).body.total).toBe(1);

      const refused = await api.patch(`/log-types/${logType.id}`, { name: 'Renamed' });
      expect(refused.status).toBe(409);
      expect(refused.body.message).toBe(`Log type ${logType.id} is archived and cannot be changed`);
    });

    it('refuses new work logs of an archived log type (422) and keeps the existing ones', async () => {
      const logType = await createLogType(ctx.prisma, orgId());
      const body = () => ({
        clientId: randomUUID(),
        occurredAt: at().toISOString(),
        logTypeId: logType.id,
        customFields: { area: 'Roof', quantity: 1 },
      });
      const existing = await api.post('/work-logs', body());
      expect(existing.status).toBe(201);

      await api.post(`/log-types/${logType.id}/archive`);

      const refused = await api.post('/work-logs', body());
      expect(refused.status).toBe(422);
      expect(detailPaths(refused)).toEqual(['logTypeId']);
      expect((await api.get(`/work-logs/${existing.body.id}`)).body.logTypeId).toBe(logType.id);
    });

    it('answers 404 for a log type that does not exist', async () => {
      const id = randomUUID();
      expect((await api.get(`/log-types/${id}`)).status).toBe(404);
      expect((await api.patch(`/log-types/${id}`, { name: 'x' })).status).toBe(404);
      expect((await api.post(`/log-types/${id}/archive`)).status).toBe(404);
    });

    it('lists by name, searches name and key, and sorts by key', async () => {
      await createLogType(ctx.prisma, orgId(), { key: 'zz_delivery', name: 'Delivery' });
      await createLogType(ctx.prisma, orgId(), { key: 'aa_inspection', name: 'Inspection' });
      await createLogType(ctx.prisma, orgId(), { key: 'mm_material', name: 'Material usage' });
      const keys = async (query: Record<string, string>) =>
        ((await api.get('/log-types', query)).body.items as Json[]).map((item) => item.key);

      expect(await keys({})).toEqual(['zz_delivery', 'aa_inspection', 'mm_material']);
      expect(await keys({ sort: 'key:asc' })).toEqual([
        'aa_inspection',
        'mm_material',
        'zz_delivery',
      ]);
      expect(await keys({ sort: 'key:desc' })).toEqual([
        'zz_delivery',
        'mm_material',
        'aa_inspection',
      ]);
      expect(await keys({ search: 'INSPECT' })).toEqual(['aa_inspection']);
      expect(await keys({ search: 'mm_' })).toEqual(['mm_material']);
      expect((await api.get('/log-types', { sort: 'version:asc' })).status).toBe(400);
    });
  });
});
