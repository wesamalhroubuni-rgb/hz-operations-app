'use client';

import {
  INITIAL_AUTH_STATE,
  type AuthActionResult,
  type AuthSessionManager,
  type AuthState,
} from '@ops/shared';
import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { authSession } from '@/lib/api/client';
import { guardRedirect, guardView } from '@/lib/auth/routes';
import { MISSING_API_URL_MESSAGE } from '@/lib/env';

import { SessionLoading } from './session-loading';

type AuthActions = Pick<
  AuthSessionManager,
  'signIn' | 'signOut' | 'signOutEverywhere' | 'setPassword'
>;

export interface AuthContextValue extends AuthActions {
  state: AuthState;
  /** Checks the session again, after the server could not be reached. */
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Without an API URL nobody can be signed in; every action says what is wrong. */
const UNCONFIGURED_STATE: AuthState = { status: 'signedOut', notice: null };
const UNCONFIGURED_RESULT: AuthActionResult = {
  ok: false,
  failure: { reason: 'unexpected', message: MISSING_API_URL_MESSAGE, details: [] },
};
const unconfigured = async (): Promise<AuthActionResult> => UNCONFIGURED_RESULT;

function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * Connects the shared session manager to React and guards the routes. All the logic is in the
 * manager (`@ops/shared`) and in `lib/auth/routes.ts`; this component only subscribes, starts the
 * session check once, and navigates.
 */
export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const state = useSyncExternalStore(
    authSession?.subscribe ?? subscribeToNothing,
    () => authSession?.getState() ?? UNCONFIGURED_STATE,
    // The server cannot know: it renders the loading state, never protected content.
    () => (authSession === null ? UNCONFIGURED_STATE : INITIAL_AUTH_STATE),
  );

  useEffect(() => {
    // Asks the API whether the cookies hold a session. Overlapping calls share one request.
    void authSession?.start();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      signIn: authSession?.signIn ?? unconfigured,
      signOut: authSession?.signOut ?? unconfigured,
      signOutEverywhere: authSession?.signOutEverywhere ?? unconfigured,
      setPassword: authSession?.setPassword ?? unconfigured,
      retry: () => void authSession?.start(),
    }),
    [state],
  );

  return (
    <AuthContext.Provider value={value}>
      <RouteGuard status={state.status}>{children}</RouteGuard>
    </AuthContext.Provider>
  );
}

/**
 * Sends signed-out users to the sign-in page and signed-in users away from it, and shows a
 * neutral loading state in the meantime so protected content never flashes.
 *
 * This is a UX guard, not a security boundary: it runs in the browser, where anyone can bypass
 * it. The API is the authority. It authenticates and authorises every request, so a user who
 * skips this guard sees an empty shell and nothing they are not allowed to see.
 */
function RouteGuard({
  status,
  children,
}: Readonly<{ status: AuthState['status']; children: ReactNode }>) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const target = guardRedirect(status, pathname, window.location.search);
    if (target !== null) {
      router.replace(target);
    }
  }, [status, pathname, router]);

  return guardView(status, pathname) === 'content' ? children : <SessionLoading />;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return value;
}
