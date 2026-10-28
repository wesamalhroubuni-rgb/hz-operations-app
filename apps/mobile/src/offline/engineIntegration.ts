import { useAuth } from '../auth/AuthProvider';
import { useOfflineSession } from '../data/DataProvider';
import { useSignOut, type SignOutScope } from '../hooks/useSignOut';
import type { OfflineSession, SignOutChoice } from './types';

// ============================================================================================
// INTEGRATION POINT (Phase 5): where the sync UI meets the offline session lifecycle.
//
// The engine is plugged into the offline runtime's seam by `engineRegistration.ts` (imported by
// `index.ts`); the data provider opens the user's session and starts its engine. These hooks
// hand the sync UI the open session, the choice-aware sign-out, and "sign in again".
// ============================================================================================

/** The open offline layer of the signed-in user. */
export function useOfflineSessionForSync(): OfflineSession | null {
  return useOfflineSession();
}

export type SignOutWithChoiceResult =
  | { ok: true }
  | { ok: false; reason: 'needsChoice' | 'notEmpty'; pending: number }
  | { ok: false; reason: 'auth' | 'unexpected' };

/** Sign-out that carries the worker's decision about unsent changes (`useSignOut`). */
export function useSignOutWithChoice(): {
  busy: SignOutScope | null;
  failure: string | null;
  run: (scope: SignOutScope, choice: SignOutChoice | null) => Promise<SignOutWithChoiceResult>;
} {
  const signOut = useSignOut();
  return {
    busy: signOut.busy,
    failure: signOut.failure,
    run: async (scope, choice) => {
      const outcome = await signOut.run(scope, choice);
      if (outcome === null) return { ok: false, reason: 'unexpected' };
      if (outcome.ok) return { ok: true };
      if (outcome.reason === 'auth') return { ok: false, reason: 'auth' };
      return { ok: false, reason: outcome.reason, pending: outcome.pending };
    },
  };
}

/** Re-checks the session: with the tokens gone, the app shows the sign-in screen. */
export function useRequestSignIn(): () => void {
  const { retry } = useAuth();
  return retry;
}
