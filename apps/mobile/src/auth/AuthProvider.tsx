import {
  type AuthActionResult,
  type AuthSessionManager,
  type AuthState,
  type AuthUser,
} from '@ops/shared';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { authSession } from '../api/client';
import { MISSING_API_URL_MESSAGE } from '../config/env';
import { deriveSessionView, previousUserToKeep, type AppSessionView } from '../offline/lifecycle';
import {
  keptUsers,
  offlineIdentity,
  offlineSessions,
  setSessionLostHandler,
} from '../offline/runtime';

type AuthActions = Pick<
  AuthSessionManager,
  'signIn' | 'signOut' | 'signOutEverywhere' | 'setPassword'
>;

export interface AuthContextValue extends AuthActions {
  /**
   * What the navigator follows. `signedIn` also when the server cannot be reached and the app
   * opened from the stored identity (`offline`): an unreachable server never signs anyone out.
   */
  state: AuthState;
  /** Signed in from the stored identity; the server could not confirm the session yet. */
  offline: boolean;
  /**
   * The user whose session ended without signing out (refresh refused). Their queued writes
   * wait on the phone; the sign-in screen asks them to sign in again (`pendingCountFor`).
   */
  needsSignIn: AuthUser | null;
  /** Checks the session again (after the server could not be reached, or the network returned). */
  retry: () => void;
  /** How many queued writes a user has on this phone (for the "N changes wait" notice). */
  pendingCountFor: (userId: string) => Promise<number>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Without an API URL nobody can be signed in; every action says what is wrong. */
const UNCONFIGURED_STATE: AuthState = { status: 'signedOut', notice: null };
const UNCONFIGURED_RESULT: AuthActionResult = {
  ok: false,
  failure: { reason: 'unexpected', message: MISSING_API_URL_MESSAGE, details: [] },
};
const unconfigured = async (): Promise<AuthActionResult> => UNCONFIGURED_RESULT;

function signedInKey(view: AppSessionView | null): string | null {
  return view?.state.status === 'signedIn' ? `${view.state.user.id}|${String(view.offline)}` : null;
}

function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * Connects the shared session manager to React and adds the offline lifecycle (ADR-0008 section
 * 11). The session logic is in the manager (`@ops/shared`); what the app shows is derived from
 * it and from the stored offline identity by `deriveSessionView` (`src/offline/lifecycle.ts`).
 */
export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const manager = useSyncExternalStore(
    authSession?.subscribe ?? subscribeToNothing,
    () => authSession?.getState() ?? UNCONFIGURED_STATE,
  );
  const identity = useSyncExternalStore(offlineIdentity.subscribe, offlineIdentity.current);

  useEffect(() => {
    void offlineIdentity.load().finally(() => void authSession?.start());
    // When the sync engine finds the session gone, re-check it: the manager then reports
    // `session_expired`, and the view turns into "sign in again" with the queue kept.
    setSessionLostHandler(() => void authSession?.start());
    return () => setSessionLostHandler(() => undefined);
  }, []);

  // The last signed-in view, so a re-check of the session keeps the screens (state adjusted
  // while rendering, only when who is signed in, or how, changes).
  const [lastSignedIn, setLastSignedIn] = useState<AppSessionView | null>(null);
  const view = useMemo(
    () => deriveSessionView(manager, authSession ? identity : null, lastSignedIn),
    [manager, identity, lastSignedIn],
  );
  const viewKey = signedInKey(view);
  if (viewKey !== signedInKey(lastSignedIn)) setLastSignedIn(viewKey === null ? null : view);

  // A confirmed sign-in becomes the stored identity. Another user's data on the phone is kept
  // (never sent) under the kept-queue rule.
  const signedInUser = manager.status === 'signedIn' ? manager.user : null;
  // Runs on a new sign-in only (not when sign-out clears the identity while the manager is still
  // signed in); the identity was loaded before the session check started.
  useEffect(() => {
    if (!signedInUser) return;
    const stored = offlineIdentity.current();
    const previousUser = previousUserToKeep(stored, signedInUser);
    if (previousUser) void keptUsers.keep(previousUser, new Date()).catch(() => undefined);
    if (JSON.stringify(stored) !== JSON.stringify(signedInUser)) {
      void offlineIdentity.save(signedInUser);
    }
  }, [signedInUser]);

  // Signed out at start: delete what signed-out users kept for longer than allowed.
  const signedOut = view.state.status === 'signedOut';
  useEffect(() => {
    if (signedOut) void offlineSessions.sweepAbandoned(new Date()).catch(() => []);
  }, [signedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state: view.state,
      offline: view.offline,
      needsSignIn: view.needsSignIn,
      signIn: authSession?.signIn ?? unconfigured,
      signOut: authSession?.signOut ?? unconfigured,
      signOutEverywhere: authSession?.signOutEverywhere ?? unconfigured,
      setPassword: authSession?.setPassword ?? unconfigured,
      retry: () => void authSession?.start(),
      pendingCountFor: (userId) => offlineSessions.pendingCountFor(userId).catch(() => 0),
    }),
    [view],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return value;
}
