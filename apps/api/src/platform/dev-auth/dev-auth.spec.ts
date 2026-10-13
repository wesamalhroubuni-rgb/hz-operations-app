import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { DEV_USER_HEADER } from '@ops/shared';
import type { PrismaService } from '../../prisma/prisma.service';
import { ApiException } from '../http/api-exception';
import { Public } from '../http/public.decorator';
import { RequestContext } from '../request-context/request-context';
import { DevActorGuard } from './dev-actor.guard';
import { isDevAuthEnabled } from './dev-auth.policy';

// The development-only acting-user header must be impossible to enable outside development.
// Two independent barriers are tested here: the pure policy (whole truth table) and the guard
// built on it. `validateEnv` (src/config/env.spec.ts) is the third; the HTTP wiring is in
// platform.http.spec.ts.

const USER_ID = '0190f3a2-7c1e-7000-8000-000000000001';
const ORG_ID = '0190f3a2-7c1e-7000-8000-0000000000aa';

const NODE_ENVS: unknown[] = [
  'development',
  'test',
  'production',
  undefined,
  null,
  '',
  'Development',
  'DEVELOPMENT',
  ' development',
  'development ',
  'dev',
  'staging',
  'prod',
  true,
  1,
  ['development'],
  { toString: () => 'development' },
];

const FLAGS: unknown[] = [
  true,
  false,
  'true',
  'false',
  'TRUE',
  '1',
  1,
  0,
  undefined,
  null,
  '',
  'yes',
  'on',
  {},
  [],
  [true],
  { valueOf: () => true },
];

describe('isDevAuthEnabled (truth table)', () => {
  const combinations = NODE_ENVS.flatMap((nodeEnv) =>
    FLAGS.map((devAuthEnabled) => ({ nodeEnv, devAuthEnabled })),
  );

  it('covers every combination of the listed environments and flag values', () => {
    expect(combinations).toHaveLength(NODE_ENVS.length * FLAGS.length);
  });

  it('is on for exactly one combination: development with the boolean true', () => {
    const enabled = combinations.filter((config) => isDevAuthEnabled(config));
    expect(enabled).toEqual([{ nodeEnv: 'development', devAuthEnabled: true }]);
  });

  it.each(
    combinations
      .filter((config) => !(config.nodeEnv === 'development' && config.devAuthEnabled === true))
      .map((config) => [config.nodeEnv, config.devAuthEnabled]),
  )('is off for NODE_ENV=%p DEV_AUTH_ENABLED=%p', (nodeEnv, devAuthEnabled) => {
    expect(isDevAuthEnabled({ nodeEnv, devAuthEnabled })).toBe(false);
  });

  it.each([['production'], ['test'], [undefined]])(
    'is off for NODE_ENV=%p even with the flag set to boolean true',
    (nodeEnv) => {
      expect(isDevAuthEnabled({ nodeEnv, devAuthEnabled: true })).toBe(false);
    },
  );

  it('returns a real boolean, never a truthy value', () => {
    expect(isDevAuthEnabled({ nodeEnv: 'development', devAuthEnabled: true })).toBe(true);
    expect(isDevAuthEnabled({ nodeEnv: 'development', devAuthEnabled: 'true' })).toBe(false);
  });
});

describe('DevActorGuard', () => {
  class Routes {
    secured(): void {}

    @Public()
    open(): void {}
  }

  function build(config: Record<string, unknown>) {
    const findUnique = jest.fn(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === USER_ID ? { id: USER_ID, organizationId: ORG_ID, archivedAt: null } : null,
      ),
    );
    const configService = { get: (key: string) => config[key] } as unknown as ConfigService;
    const prisma = { user: { findUnique } } as unknown as PrismaService;
    return { guard: new DevActorGuard(new Reflector(), configService, prisma), findUnique };
  }

  /** An HTTP execution context whose request records every header that is read. */
  function httpContext(handler: 'secured' | 'open', headers: Record<string, string>) {
    const read: string[] = [];
    const request = {
      headers: new Proxy(headers, {
        get(target, key) {
          read.push(String(key));
          return target[String(key)];
        },
      }),
    };
    const context = {
      getType: () => 'http',
      getHandler: () => Routes.prototype[handler],
      getClass: () => Routes,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, read };
  }

  function inRequest<Result>(callback: () => Result): Result {
    return RequestContext.run({ correlationId: 'c-1', actor: null }, callback);
  }

  it.each<[string, Record<string, unknown>]>([
    ['production with the flag forced to true', { NODE_ENV: 'production', DEV_AUTH_ENABLED: true }],
    ['test with the flag forced to true', { NODE_ENV: 'test', DEV_AUTH_ENABLED: true }],
    ['no NODE_ENV with the flag forced to true', { DEV_AUTH_ENABLED: true }],
    ['a NODE_ENV typo with the flag true', { NODE_ENV: 'Development', DEV_AUTH_ENABLED: true }],
    ['development with the flag false', { NODE_ENV: 'development', DEV_AUTH_ENABLED: false }],
    ['development with the string "true"', { NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true' }],
    ['development with the number 1', { NODE_ENV: 'development', DEV_AUTH_ENABLED: 1 }],
    ['development with no flag', { NODE_ENV: 'development' }],
    ['no configuration at all', {}],
  ])(
    'rejects a valid dev header under %s, without reading it or the database',
    async (_name, config) => {
      const { guard, findUnique } = build(config);
      const { context, read } = httpContext('secured', { [DEV_USER_HEADER]: USER_ID });

      const outcome = inRequest(() => guard.canActivate(context));

      await expect(outcome).rejects.toBeInstanceOf(ApiException);
      await expect(outcome).rejects.toMatchObject({
        code: 'unauthenticated',
        message: 'Authentication is not available yet',
      });
      expect(findUnique).not.toHaveBeenCalled();
      expect(read).toEqual([]);
      expect(inRequest(() => RequestContext.actor())).toBeNull();
    },
  );

  it('does not set an actor when it rejects', async () => {
    const { guard } = build({ NODE_ENV: 'production', DEV_AUTH_ENABLED: true });
    const { context } = httpContext('secured', { [DEV_USER_HEADER]: USER_ID });

    const actor = await inRequest(async () => {
      await guard.canActivate(context).catch(() => undefined);
      return RequestContext.actor();
    });

    expect(actor).toBeNull();
  });

  it('still lets a @Public() route through in production, without an actor', async () => {
    const { guard, findUnique } = build({ NODE_ENV: 'production', DEV_AUTH_ENABLED: true });
    const { context, read } = httpContext('open', { [DEV_USER_HEADER]: USER_ID });

    const actor = await inRequest(async () => {
      await expect(guard.canActivate(context)).resolves.toBe(true);
      return RequestContext.actor();
    });

    expect(actor).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
    expect(read).toEqual([]);
  });

  it('accepts the header only in development with the boolean flag, and sets the actor', async () => {
    const { guard, findUnique } = build({ NODE_ENV: 'development', DEV_AUTH_ENABLED: true });
    const { context } = httpContext('secured', { [DEV_USER_HEADER]: USER_ID });

    const actor = await inRequest(async () => {
      await expect(guard.canActivate(context)).resolves.toBe(true);
      return RequestContext.actor();
    });

    expect(actor).toEqual({ userId: USER_ID, organizationId: ORG_ID });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing, malformed or unknown user even when enabled', async () => {
    const { guard, findUnique } = build({ NODE_ENV: 'development', DEV_AUTH_ENABLED: true });

    const rejected: Array<Record<string, string>> = [
      {},
      { [DEV_USER_HEADER]: '' },
      { [DEV_USER_HEADER]: 'not-a-uuid' },
      { [DEV_USER_HEADER]: `${USER_ID},${USER_ID}` },
    ];
    for (const headers of rejected) {
      const { context } = httpContext('secured', headers);
      await expect(inRequest(() => guard.canActivate(context))).rejects.toMatchObject({
        code: 'unauthenticated',
      });
    }
    expect(findUnique).not.toHaveBeenCalled();

    const unknown = httpContext('secured', {
      [DEV_USER_HEADER]: '0190f3a2-7c1e-7000-8000-0000000000ff',
    });
    await expect(inRequest(() => guard.canActivate(unknown.context))).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('warns at start-up only when dev auth is really enabled', () => {
    const warn = jest.fn();
    const production = build({ NODE_ENV: 'production', DEV_AUTH_ENABLED: true }).guard;
    const development = build({ NODE_ENV: 'development', DEV_AUTH_ENABLED: true }).guard;
    // The logger is a private detail; replacing it is the only way to observe the warning.
    Object.assign(production, { logger: { warn } });
    Object.assign(development, { logger: { warn } });

    production.onModuleInit();
    expect(warn).not.toHaveBeenCalled();

    development.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('DEV AUTH IS ENABLED');
  });
});
