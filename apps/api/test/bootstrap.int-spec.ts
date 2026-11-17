import { bootstrapOrganization } from '../src/operations/seed/bootstrap-organization';
import { UsersService } from '../src/operations/users/users.service';
import { createTenant } from './support/factories';
import { startTestApp, type TestApp } from './support/test-app';

// The production bootstrap (`pnpm db:bootstrap`): the real organization and its first
// administrator, without demo data. Example values only.

const PASSWORD = 'Example-Bootstrap-Phrase-77';

const input = {
  organizationName: 'Example Works',
  organizationSlug: 'example-works',
  timeZone: 'Asia/Riyadh',
  adminName: 'First Admin',
  adminEmail: 'Admin@Example.com',
  adminPassword: PASSWORD,
};

describe('organization bootstrap', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(() => ctx.reset());
  afterAll(() => ctx.close());

  it('creates the organization and an org-wide admin who can sign in, and nothing else', async () => {
    const result = await bootstrapOrganization(ctx.app, input);
    expect(result.created).toBe(true);

    const organization = await ctx.prisma.organization.findUniqueOrThrow({
      where: { id: result.organizationId },
    });
    expect(organization).toMatchObject({ name: 'Example Works', slug: 'example-works' });
    expect(organization.settings).toMatchObject({ timeZone: 'Asia/Riyadh', locale: 'en' });

    const membership = await ctx.prisma.membership.findFirstOrThrow({
      where: { userId: result.adminUserId! },
    });
    expect(membership).toMatchObject({ role: 'admin', orgWide: true });

    // No demo data: one user, no sites, teams, log types, tasks or logs.
    expect(await ctx.prisma.user.count()).toBe(1);
    expect(await ctx.prisma.site.count()).toBe(0);
    expect(await ctx.prisma.team.count()).toBe(0);
    expect(await ctx.prisma.logType.count()).toBe(0);
    expect(await ctx.prisma.task.count()).toBe(0);
    expect(await ctx.prisma.workLog.count()).toBe(0);

    const login = await ctx.loginAs('admin@example.com', PASSWORD, {
      organizationSlug: 'example-works',
    });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ displayName: 'First Admin', role: 'admin' });

    // Audited, and the password is in neither the audit nor the outbox.
    const audit = JSON.stringify(await ctx.prisma.auditEvent.findMany(), (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(audit).toContain('"organization"');
    expect(audit).not.toContain(PASSWORD);
    const outbox = JSON.stringify(
      await ctx.prisma.outboxEvent.findMany(),
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );
    expect(outbox).not.toContain(PASSWORD);
  });

  it('changes nothing when the slug exists already', async () => {
    const first = await bootstrapOrganization(ctx.app, input);
    const second = await bootstrapOrganization(ctx.app, {
      ...input,
      adminPassword: 'Another-Long-Phrase-12',
    });
    expect(second).toEqual({
      created: false,
      organizationId: first.organizationId,
      adminUserId: null,
    });
    expect(await ctx.prisma.user.count()).toBe(1);
    expect(
      (await ctx.loginAs('admin@example.com', PASSWORD, { organizationSlug: 'example-works' }))
        .status,
    ).toBe(200);
  });

  it('refuses a weak password before writing anything', async () => {
    await expect(
      bootstrapOrganization(ctx.app, { ...input, adminPassword: 'short' }),
    ).rejects.toThrow();
    expect(await ctx.prisma.user.count()).toBe(0);
    expect(await ctx.prisma.organization.count()).toBe(0);
  });

  it('refuses a bad slug or time zone before writing anything', async () => {
    await expect(
      bootstrapOrganization(ctx.app, { ...input, organizationSlug: 'Not A Slug!' }),
    ).rejects.toThrow();
    await expect(
      bootstrapOrganization(ctx.app, { ...input, timeZone: 'Mars/Olympus' }),
    ).rejects.toThrow();
    expect(await ctx.prisma.organization.count()).toBe(0);
  });

  it('cannot be used to set a password on an existing user from a request', async () => {
    const tenant = await createTenant(ctx.prisma);
    // The method needs the system context; inside a request it is refused.
    const response = await ctx.as(tenant.admin.id).get('/auth/me');
    expect(response.status).toBe(200);
    await expect(
      ctx.app
        .get(UsersService)
        .createWithFirstPassword({ displayName: 'X', username: 'x1' }, PASSWORD),
    ).rejects.toThrow();
  });
});
