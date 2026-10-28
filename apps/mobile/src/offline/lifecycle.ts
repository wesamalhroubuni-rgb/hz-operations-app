import type { AuthActionFailure, AuthActionResult, AuthState, AuthUser } from '@ops/shared';

import type {
  OfflineIdentityStore,
  OfflineSessionFactory,
  SignOutChoice,
  SyncEngine,
  WriteQueue,
} from './types';

// The offline session lifecycle (ADR-0008 section 11), as pure logic the auth provider and the
// sign-out hook call.
//
// - The app opens signed in from the stored identity when the server cannot be reached: an
//   unreachable server never signs the worker out.
// - When the session is gone (refresh refused), the queue is kept and the sign-in screen names
//   the user whose writes wait (`needsSignIn`). The same user signing in resumes their database;
//   another user gets their own, and the previous user's data is only ever kept, never sent.
// - Sign-out with queued writes needs an explicit choice.

/** What the app shows, derived from the session manager and the stored identity. */
export interface AppSessionView {
  /** The state the navigator follows (signed in also while offline from the stored identity). */
  state: AuthState;
  /** Signed in from the stored identity because the server could not be reached. */
  offline: boolean;
  /** The user whose sign-in expired; their queued writes wait for them. */
  needsSignIn: AuthUser | null;
}

/**
 * @param identity The stored identity; `undefined` while it is still being read.
 * @param previous The last view, so a re-check of the session does not flash the loading screen.
 */
export function deriveSessionView(
  manager: AuthState,
  identity: AuthUser | null | undefined,
  previous: AppSessionView | null,
): AppSessionView {
  if (manager.status === 'signedIn') {
    return { state: manager, offline: false, needsSignIn: null };
  }
  if (manager.status === 'loading' || identity === undefined) {
    // A re-check while signed in (e.g. after the network came back) keeps the screens.
    if (previous && previous.state.status === 'signedIn') return previous;
    return { state: { status: 'loading' }, offline: false, needsSignIn: null };
  }
  if (identity !== null) {
    if (manager.notice === 'unreachable') {
      return { state: { status: 'signedIn', user: identity }, offline: true, needsSignIn: null };
    }
    if (manager.notice === null || manager.notice === 'session_expired') {
      // The session is gone but the user did not sign out: their data waits for them.
      return { state: manager, offline: false, needsSignIn: identity };
    }
  }
  return { state: manager, offline: false, needsSignIn: null };
}

/**
 * Whose data the phone must keep when `user` signs in: the previously stored identity, when it
 * is somebody else (their queue stays under the kept-queue rule, never sent by this user).
 */
export function previousUserToKeep(
  identity: AuthUser | null | undefined,
  user: AuthUser,
): string | null {
  return identity && identity.id !== user.id ? identity.id : null;
}

export type SignOutOutcome =
  | { ok: true }
  /** Queued writes exist: ask the worker (sync first / keep for later / discard / cancel). */
  | { ok: false; reason: 'needsChoice'; pending: number; failed: number }
  /** "Sync first" ran but writes are still queued (offline, or refused ones). */
  | { ok: false; reason: 'notEmpty'; pending: number; failed: number }
  /** The server did not confirm (sign out everywhere): still signed in, nothing deleted. */
  | { ok: false; reason: 'auth'; failure: AuthActionFailure };

export interface SignOutDeps {
  user: AuthUser;
  queue: Pick<WriteQueue, 'pendingCount' | 'counts'>;
  engine: Pick<SyncEngine, 'syncNow'>;
  factory: Pick<OfflineSessionFactory, 'signOutCleanup'>;
  identity: OfflineIdentityStore;
  /** `signOut` or `signOutEverywhere` of the session manager. */
  endSession: () => Promise<AuthActionResult>;
  /** Runs while the session still works (unregister the push token). */
  beforeEnd?: () => Promise<void>;
}

async function queueState(
  queue: SignOutDeps['queue'],
): Promise<{ pending: number; failed: number }> {
  const counts = await queue.counts();
  return { pending: await queue.pendingCount(), failed: counts.failed_permanent };
}

/**
 * Signs out. With `choice` null and an empty queue it signs out and deletes the user's offline
 * data; with queued writes it answers `needsChoice` and changes nothing. With a choice:
 * `syncFirst` syncs and signs out only if the queue is then empty; `keepForLater` keeps the
 * queue and photos for the same user's next sign-in (cache deleted); `discard` deletes all.
 */
export async function signOutWithChoice(
  deps: SignOutDeps,
  choice: SignOutChoice | null,
): Promise<SignOutOutcome> {
  let state = await queueState(deps.queue);
  if (state.pending > 0 && choice === null) {
    return { ok: false, reason: 'needsChoice', ...state };
  }
  if (choice === 'syncFirst' && state.pending > 0) {
    await deps.engine.syncNow('manual');
    state = await queueState(deps.queue);
    if (state.pending > 0) return { ok: false, reason: 'notEmpty', ...state };
  }
  await deps.beforeEnd?.().catch(() => undefined);
  // The identity goes first, so the signed-out screen does not offer "sign in again" for it.
  await deps.identity.clear();
  const result = await deps.endSession();
  if (!result.ok) {
    await deps.identity.save(deps.user);
    return { ok: false, reason: 'auth', failure: result.failure };
  }
  const cleanup: SignOutChoice = state.pending === 0 ? 'discard' : (choice ?? 'keepForLater');
  await deps.factory.signOutCleanup(deps.user.id, cleanup).catch(() => undefined);
  return { ok: true };
}
