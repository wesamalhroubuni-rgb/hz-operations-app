import type { AuthState } from '@ops/shared';

/** The screen a signed-out user chose. There is no navigation library yet; this is the whole map. */
export type SignedOutScreen = 'login' | 'activate';

export type Screen = 'loading' | 'home' | SignedOutScreen;

/**
 * Which screen to show. The sign-in state decides; only a signed-out user has a choice (the
 * sign-in form or the activation form). Showing the home screen here is a convenience, not a
 * security control: the API authenticates and authorises every request.
 */
export function screenFor(status: AuthState['status'], chosen: SignedOutScreen): Screen {
  if (status === 'loading') {
    return 'loading';
  }
  return status === 'signedIn' ? 'home' : chosen;
}
