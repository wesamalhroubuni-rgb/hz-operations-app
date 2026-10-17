import type { AuthState } from '@ops/shared';

/** Which navigator the app shows. */
export type RootView = 'loading' | 'signedOut' | 'signedIn';

/**
 * The sign-in state decides the navigator: nothing but a spinner while the stored session is
 * checked, the sign-in stack when signed out, the tabs when signed in. Showing the signed-in
 * screens is a convenience, not a security control: the API authenticates and authorises every
 * request.
 */
export function rootViewFor(status: AuthState['status']): RootView {
  return status;
}
