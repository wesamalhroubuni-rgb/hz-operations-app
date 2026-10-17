import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { startAttachmentUploadSchema } from './attachments.js';
import { createLogTypeSchema, updateLogTypeSchema } from './log-types.js';
import {
  createMembershipSchema,
  membershipScopeIssues,
  updateMembershipSchema,
} from './memberships.js';
import {
  DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS,
  MAX_WORK_LOG_EDIT_WINDOW_HOURS,
  updateOrganizationSchema,
  workLogEditWindowHoursOf,
} from './organization.js';
import { createSiteSchema, listSitesQuerySchema, updateSiteSchema } from './sites.js';
import {
  changeTaskStatusSchema,
  createTaskSchema,
  listTasksQuerySchema,
  setTaskAssigneesSchema,
  updateTaskSchema,
} from './tasks.js';
import { createTeamSchema, updateTeamSchema } from './teams.js';
import { createUserSchema, updateUserSchema } from './users.js';
import {
  changeWorkLogStatusSchema,
  createWorkLogSchema,
  listWorkLogsQuerySchema,
  updateWorkLogSchema,
} from './work-logs.js';

// Request bodies are strict: a key the schema does not know is a mistake of the caller and is
// refused, never silently dropped. Query strings stay lenient.

const ID = '0190f3a2-7c1e-7000-8000-000000000001';

/** Every write schema with one body it accepts. */
const BODIES: Array<[string, z.ZodType, Record<string, unknown>]> = [
  ['updateOrganizationSchema', updateOrganizationSchema, { name: 'HZ Demo' }],
  ['createUserSchema', createUserSchema, { email: 'a@example.test', displayName: 'A' }],
  ['updateUserSchema', updateUserSchema, { displayName: 'A' }],
  ['createMembershipSchema', createMembershipSchema, { userId: ID, role: 'worker' }],
  ['updateMembershipSchema', updateMembershipSchema, { role: 'worker' }],
  ['createSiteSchema', createSiteSchema, { name: 'North' }],
  ['updateSiteSchema', updateSiteSchema, { name: 'North' }],
  ['createTeamSchema', createTeamSchema, { name: 'Electrical' }],
  ['updateTeamSchema', updateTeamSchema, { name: 'Electrical' }],
  ['createLogTypeSchema', createLogTypeSchema, { key: 'inspection', name: 'Inspection' }],
  ['updateLogTypeSchema', updateLogTypeSchema, { name: 'Inspection' }],
  ['createTaskSchema', createTaskSchema, { title: 'Fix the door' }],
  ['updateTaskSchema', updateTaskSchema, { title: 'Fix the door' }],
  ['changeTaskStatusSchema', changeTaskStatusSchema, { status: 'done' }],
  ['setTaskAssigneesSchema', setTaskAssigneesSchema, { assigneeIds: [ID] }],
  [
    'createWorkLogSchema',
    createWorkLogSchema,
    { clientId: ID, occurredAt: '2026-09-01T08:00:00Z' },
  ],
  ['updateWorkLogSchema', updateWorkLogSchema, { text: 'Checked' }],
  ['changeWorkLogStatusSchema', changeWorkLogStatusSchema, { status: 'approved' }],
  [
    'startAttachmentUploadSchema',
    startAttachmentUploadSchema,
    { fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 1 },
  ],
];

describe('strict request bodies', () => {
  it.each(BODIES)('%s accepts its valid body', (_name, schema, body) => {
    expect(schema.safeParse(body).success).toBe(true);
  });

  it.each(BODIES)('%s refuses an unknown key and names it', (_name, schema, body) => {
    const result = schema.safeParse({ ...body, organizationId: ID, colour: 'red' });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      keys: ['organizationId', 'colour'],
    });
    expect(issues[0]?.message).toContain('"organizationId"');
    expect(issues[0]?.message).toContain('"colour"');
  });

  it.each(BODIES)(
    '%s refuses the server-owned keys id, createdAt and archivedAt',
    (_name, schema, body) => {
      for (const key of ['id', 'createdAt', 'updatedAt', 'archivedAt']) {
        expect(schema.safeParse({ ...body, [key]: '2026-09-01T08:00:00Z' }).success).toBe(false);
      }
    },
  );

  it('refuses the keys that have their own endpoint or cannot change', () => {
    expect(updateTaskSchema.safeParse({ title: 'T', status: 'done' }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ title: 'T', assigneeIds: [ID] }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: 'T', createdById: ID }).success).toBe(false);
    expect(updateLogTypeSchema.safeParse({ name: 'N', key: 'renamed' }).success).toBe(false);
    expect(updateWorkLogSchema.safeParse({ text: 'x', authorId: ID }).success).toBe(false);
    expect(updateWorkLogSchema.safeParse({ text: 'x', clientId: ID }).success).toBe(false);
    expect(updateWorkLogSchema.safeParse({ text: 'x', status: 'approved' }).success).toBe(false);
    expect(
      createWorkLogSchema.safeParse({
        clientId: ID,
        occurredAt: '2026-09-01T08:00:00Z',
        latitude: 41,
        longitude: 29,
      }).success,
    ).toBe(false);
    expect(updateMembershipSchema.safeParse({ role: 'admin', userId: ID }).success).toBe(false);
  });

  it('refuses the author, creator and uploader fields: the server sets them', () => {
    const log = { clientId: ID, occurredAt: '2026-09-01T08:00:00Z' };
    expect(createWorkLogSchema.safeParse({ ...log, authorId: ID }).success).toBe(false);
    expect(updateWorkLogSchema.safeParse({ text: 'x', authorId: ID }).success).toBe(false);
    expect(createTaskSchema.safeParse({ title: 'T', createdById: ID }).success).toBe(false);
    expect(updateTaskSchema.safeParse({ title: 'T', createdById: ID }).success).toBe(false);
    expect(
      startAttachmentUploadSchema.safeParse({
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        uploadedById: ID,
      }).success,
    ).toBe(false);
    // The storage key is chosen by the API: a client cannot send one.
    expect(
      startAttachmentUploadSchema.safeParse({
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 1,
        storageKey: 'org/x/a.jpg',
      }).success,
    ).toBe(false);
  });

  it('creates a work log as draft or submitted only', () => {
    const log = { clientId: ID, occurredAt: '2026-09-01T08:00:00Z' };
    expect(createWorkLogSchema.parse(log).status).toBe('submitted');
    expect(createWorkLogSchema.safeParse({ ...log, status: 'draft' }).success).toBe(true);
    expect(createWorkLogSchema.safeParse({ ...log, status: 'approved' }).success).toBe(false);
    expect(createWorkLogSchema.safeParse({ ...log, status: 'rejected' }).success).toBe(false);
  });
});

describe('user identifiers', () => {
  it('needs a display name and at least one of email, phone and username', () => {
    expect(createUserSchema.safeParse({ displayName: 'A' }).success).toBe(false);
    expect(createUserSchema.safeParse({ displayName: 'A', email: null }).success).toBe(false);
    expect(
      createUserSchema.safeParse({ displayName: 'A', phone: '+90 532 555 01 02' }).success,
    ).toBe(true);
    expect(createUserSchema.safeParse({ displayName: 'A', username: 'a.worker' }).success).toBe(
      true,
    );
    expect(createUserSchema.safeParse({ email: 'a@example.test' }).success).toBe(false);
  });

  it('normalises what it accepts', () => {
    expect(
      createUserSchema.parse({
        displayName: '  Deniz  ',
        email: ' Deniz@Example.TEST ',
        phone: '+90 (532) 555-01 02',
        username: ' Deniz.Y ',
      }),
    ).toEqual({
      displayName: 'Deniz',
      email: 'deniz@example.test',
      phone: '+905325550102',
      username: 'deniz.y',
    });
  });

  it.each(['12345', '+12 34', 'call me', '+90+532555', '5'.repeat(21)])(
    'refuses the phone number %j',
    (phone) => {
      expect(createUserSchema.safeParse({ displayName: 'A', phone }).success).toBe(false);
    },
  );

  it.each(['ab', 'a'.repeat(33), '123456', 'has space', 'a@b', 'ünal'])(
    'refuses the username %j',
    (username) => {
      expect(createUserSchema.safeParse({ displayName: 'A', username }).success).toBe(false);
    },
  );
});

describe('membership scope by role', () => {
  it.each(['manager', 'admin'] as const)('a %s membership must be organization-wide', (role) => {
    expect(createMembershipSchema.safeParse({ userId: ID, role, orgWide: true }).success).toBe(
      true,
    );
    const scoped = createMembershipSchema.safeParse({ userId: ID, role, siteIds: [ID] });
    expect(scoped.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'orgWide',
      'siteIds',
    ]);
    expect(
      membershipScopeIssues({ role, orgWide: true, siteIds: [], teamIds: [ID] }).map(
        (issue) => issue.path,
      ),
    ).toEqual(['teamIds']);
  });

  it.each(['worker', 'supervisor'] as const)('a %s membership may have any scope', (role) => {
    expect(membershipScopeIssues({ role, orgWide: false, siteIds: [ID], teamIds: [ID] })).toEqual(
      [],
    );
    expect(membershipScopeIssues({ role, orgWide: true, siteIds: [], teamIds: [] })).toEqual([]);
  });
});

describe('organization settings', () => {
  it('validates the work-log edit window and keeps other keys', () => {
    const settings = { workLogEditWindowHours: 48, timeZone: 'Europe/Istanbul' };
    expect(updateOrganizationSchema.parse({ settings })).toEqual({ settings });
    for (const workLogEditWindowHours of [0, -1, '24', MAX_WORK_LOG_EDIT_WINDOW_HOURS + 1]) {
      expect(
        updateOrganizationSchema.safeParse({ settings: { workLogEditWindowHours } }).success,
      ).toBe(false);
    }
  });

  it('falls back to the default window when the setting is absent or unusable', () => {
    expect(workLogEditWindowHoursOf({})).toBe(DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS);
    expect(workLogEditWindowHoursOf(null)).toBe(DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS);
    expect(workLogEditWindowHoursOf({ workLogEditWindowHours: '12' })).toBe(
      DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS,
    );
    expect(workLogEditWindowHoursOf({ workLogEditWindowHours: 0 })).toBe(
      DEFAULT_WORK_LOG_EDIT_WINDOW_HOURS,
    );
    expect(workLogEditWindowHoursOf({ workLogEditWindowHours: 2 })).toBe(2);
  });

  it('still reports an update with no field at all', () => {
    const result = updateSiteSchema.safeParse({});
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'Provide at least one field to update',
    ]);
  });
});

describe('what stays open on purpose', () => {
  it('organization settings accept any keys', () => {
    const settings = { timezone: 'Europe/Istanbul', features: { voice: true }, anything: [1, 2] };
    expect(updateOrganizationSchema.parse({ settings })).toEqual({ settings });
  });

  it('custom field values accept any keys here: the log type decides which are valid', () => {
    const body = {
      clientId: ID,
      occurredAt: '2026-09-01T08:00:00Z',
      customFields: { area: 'Roof', anything_else: 5 },
    };
    expect(createWorkLogSchema.parse(body).customFields).toEqual(body.customFields);
    expect(updateWorkLogSchema.parse({ customFields: body.customFields }).customFields).toEqual(
      body.customFields,
    );
  });

  it.each([
    ['listSitesQuerySchema', listSitesQuerySchema],
    ['listTasksQuerySchema', listTasksQuerySchema],
    ['listWorkLogsQuerySchema', listWorkLogsQuerySchema],
  ])('%s ignores unknown query parameters', (_name, schema) => {
    const result = schema.safeParse({ page: '2', utm_source: 'mail', _: '1699' });
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty('utm_source');
  });
});
