import { USER_RECHECK_MS, userRefreshAfterPull } from './liveUpdates';

describe('userRefreshAfterPull', () => {
  it('re-checks the user at once when the pull says the scope changed', () => {
    expect(userRefreshAfterPull({ scopeChanged: true })).toEqual({});
  });

  it('otherwise re-checks at most once a minute', () => {
    expect(userRefreshAfterPull({ scopeChanged: false })).toEqual({ maxAgeMs: USER_RECHECK_MS });
    expect(USER_RECHECK_MS).toBe(60_000);
  });
});
