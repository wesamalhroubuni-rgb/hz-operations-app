import { type AuthActionResult, type AuthSessionManager, type AuthState } from '@ops/shared';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { authSession } from '../api/client';
import { MISSING_API_URL_MESSAGE } from '../config/env';

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
 * Connects the shared session manager to React. All the logic is in the manager (`@ops/shared`);
 * this component only subscribes and starts the session check once: the manager loads the tokens
 * from SecureStore and asks the API who they belong to.
 */
export function AuthProvider({ children }: Readonly<{ children: ReactNode }>) {
  const state = useSyncExternalStore(
    authSession?.subscribe ?? subscribeToNothing,
    () => authSession?.getState() ?? UNCONFIGURED_STATE,
  );

  useEffect(() => {
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

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return value;
}
