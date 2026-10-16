import { AuditService } from '../audit/audit.service';
import type { NotificationSender } from '../notifications/notification-sender';
import { AuthAdminService } from './auth-admin.service';
import { authSettingsFromConfig } from './auth-settings';
import { systemClock, systemRandom } from './clock';
import { OneTimeCodes } from './one-time-codes';
import { PasswordHasher } from './password-hasher';
import { AccessTokenService } from './access-token';
import { SessionService } from './sessions';

// Example values only.
const SECRET = 'unit-test-signing-key-0123456789-abcdefghij';
const A = '0190f3a2-7c1e-7000-8000-000000000001';
const B = '0190f3a2-7c1e-7000-8000-000000000002';
const C = '0190f3a2-7c1e-7000-8000-000000000003';

function service(): AuthAdminService {
  const settings = authSettingsFromConfig(
    (key) => ({ AUTH_ACCESS_TOKEN_SECRET: SECRET, NODE_ENV: 'test' })[key],
  );
  const sender: NotificationSender = { sendOneTimeCode: () => Promise.resolve() };
  return new AuthAdminService(
    settings,
    systemClock,
    new OneTimeCodes(systemClock, systemRandom, settings),
    new SessionService(
      systemClock,
      systemRandom,
      settings,
      new AccessTokenService(SECRET, 900, systemClock),
    ),
    new PasswordHasher(),
    new AuditService(),
    sender,
  );
}

describe('AuthAdminService.activatedUserIds', () => {
  it('answers which users have a password, in one query', async () => {
    const findMany = jest.fn().mockResolvedValue([{ userId: A }, { userId: C }]);
    const result = await service().activatedUserIds({ authCredential: { findMany } }, [A, B, C, A]);
    expect(result).toEqual(new Set([A, C]));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: { in: [A, B, C] } },
      select: { userId: true },
    });
  });

  it('does not query for an empty list', async () => {
    const findMany = jest.fn();
    expect(await service().activatedUserIds({ authCredential: { findMany } }, [])).toEqual(
      new Set(),
    );
    expect(findMany).not.toHaveBeenCalled();
  });
});
