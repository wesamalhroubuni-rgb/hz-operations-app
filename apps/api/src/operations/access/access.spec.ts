import { parseLoginIdentifier } from '../../platform/auth/identifiers';
import { RequestContext } from '../../platform/request-context/request-context';
import { createUserSchema } from '@ops/shared';
import type { ScopeService } from '../scope/scope.service';
import { authorOf } from './access-context';
import { AccessService } from './access.service';
import { OperationsRequestAuthorizer, mayUsePolicy } from './operations-request-authorizer';
import { listPolicies, POLICIES } from './policies';
import { contextFor } from './testing';

function fakeScope(roles: string[] = ['worker']) {
  const resolveForUser = jest.fn(async (organizationId: string, userId: string) => ({
    ...contextFor(userId, roles as never).scope,
    organizationId,
  }));
  return { service: { resolveForUser } as unknown as ScopeService, resolveForUser };
}

const actor = { userId: 'u1', organizationId: 'org' };
const inRequest = <T>(work: () => Promise<T>) =>
  RequestContext.run({ correlationId: 'c', actor }, work);

describe('policy registry', () => {
  it('names every policy as <resource>.<action> in snake_case, with at least one role', () => {
    for (const policy of listPolicies()) {
      expect(policy.name).toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(policy.roles.length).toBeGreaterThan(0);
      expect(policy.description.length).toBeGreaterThan(0);
    }
  });

  it('refuses an unknown policy and a role that is not listed', () => {
    expect(mayUsePolicy(undefined, { roles: ['admin'] })).toBe(false);
    expect(mayUsePolicy(POLICIES['membership.manage'], { roles: ['manager'] })).toBe(false);
    expect(mayUsePolicy(POLICIES['membership.manage'], { roles: ['admin'] })).toBe(true);
    expect(mayUsePolicy(POLICIES['task.manage'], { roles: ['worker', 'supervisor'] })).toBe(true);
    expect(mayUsePolicy(POLICIES['work_log.read'], { roles: [] })).toBe(false);
  });
});

describe('AccessService', () => {
  it('answers 401 without a signed-in user', async () => {
    await expect(new AccessService(fakeScope().service).context()).rejects.toMatchObject({
      status: 401,
    });
  });

  it('resolves the context once per request', async () => {
    const scope = fakeScope(['supervisor']);
    const access = new AccessService(scope.service);
    await inRequest(async () => {
      const first = await access.context();
      const second = await access.context();
      expect(second).toBe(first);
      expect(first.isSupervisorOrAbove).toBe(true);
    });
    await inRequest(() => access.context());
    expect(scope.resolveForUser).toHaveBeenCalledTimes(2);
  });

  it('runs as the system only outside a request', async () => {
    const access = new AccessService(fakeScope().service);
    const context = await access.runAsSystem('org', () => access.context());
    expect(context).toMatchObject({ system: true, isAdmin: true, organizationId: 'org' });
    await inRequest(async () => {
      expect(() => access.runAsSystem('org', async () => null)).toThrow();
    });
  });

  it('runs as a user read-only outside a request, with that user scope (Phase 7)', async () => {
    const scope = fakeScope(['supervisor']);
    const access = new AccessService(scope.service);
    const context = await access.runAsUser('org', 'u7', () => access.context());
    expect(context).toMatchObject({
      userId: 'u7',
      organizationId: 'org',
      system: false,
      readOnly: true,
      isSupervisorOrAbove: true,
      isManagerOrAbove: false,
    });
    expect(() => authorOf(context)).toThrow();
    expect(scope.resolveForUser).toHaveBeenCalledWith('org', 'u7');
  });

  it('applies a background context in a context without an actor, never in a signed-in request', async () => {
    const access = new AccessService(fakeScope(['worker']).service);
    const handler = await RequestContext.run({ correlationId: 'event', actor: null }, () =>
      access.runAsUser('org', 'u7', () => access.context()),
    );
    expect(handler.userId).toBe('u7');
    await inRequest(async () => {
      await expect(access.runAsUser('org', 'u7', async () => null)).rejects.toThrow();
      const own = await access.context();
      expect(own.userId).toBe('u1');
    });
  });
});

describe('OperationsRequestAuthorizer', () => {
  function authorizer(roles: string[], nodeEnv: string) {
    const access = new AccessService(fakeScope(roles).service);
    const config = { get: () => nodeEnv } as never;
    return new OperationsRequestAuthorizer(access, config);
  }

  it('allows a listed role and refuses others with 403', async () => {
    await inRequest(async () => {
      await expect(
        authorizer(['admin'], 'development').authorize({ policy: 'user.manage', actor }),
      ).resolves.toBeUndefined();
      await expect(
        authorizer(['supervisor'], 'development').authorize({
          policy: 'membership.manage',
          actor,
        }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        authorizer(['admin'], 'development').authorize({ policy: 'no.such_policy', actor }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it('hides the outbox in production (404) and keeps it admin-only elsewhere', async () => {
    await inRequest(async () => {
      await expect(
        authorizer(['admin'], 'production').authorize({ policy: 'outbox.read', actor }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        authorizer(['admin'], 'test').authorize({ policy: 'outbox.read', actor }),
      ).resolves.toBeUndefined();
      await expect(
        authorizer(['manager'], 'development').authorize({ policy: 'outbox.read', actor }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});

describe('user identifiers are stored as sign-in looks them up', () => {
  it.each([
    ['email', ' Deniz@Example.COM '],
    ['phone', '+90 (532) 555-01 02'],
    ['phone', '0532 555 01 02'],
    ['username', ' Deniz.Y '],
  ] as const)('normalises the %s %j the same way', (field, typed) => {
    const stored = createUserSchema.parse({ displayName: 'D', [field]: typed })[field];
    expect(parseLoginIdentifier(typed)).toEqual({ kind: field, value: stored });
  });
});
