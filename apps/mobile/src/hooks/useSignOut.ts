import { useState } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { useData } from '../data/DataProvider';
import { authFailureText } from '../i18n/authText';
import { unregisterBackgroundSync } from '../offline/background';
import { signOutWithChoice, type SignOutOutcome } from '../offline/lifecycle';
import { offlineIdentity, offlineSessions } from '../offline/runtime';
import type { SignOutChoice } from '../offline/types';
import { usePushService } from '../push/usePush';

export type SignOutScope = 'device' | 'everywhere';

/** Queued writes that make sign-out ask first. */
export interface SignOutPrompt {
  scope: SignOutScope;
  pending: number;
  failed: number;
}

/**
 * Runs "Sign out" and "Sign out everywhere" (ADR-0008 section 8). With queued writes on the
 * phone, `run(scope)` changes nothing and sets `prompt`: the screen asks the worker and calls
 * `run(scope, choice)` with `syncFirst`, `keepForLater` or `discard` (or `cancel()`). After
 * `syncFirst` with writes still queued, `notEmpty` says how many remain. On success the user's
 * offline data is deleted (empty queue or `discard`) or kept for their next sign-in
 * (`keepForLater`), and the app switches to the sign-in screen. This phone's push token is
 * removed first, while the session can still authorise it.
 */
export function useSignOut() {
  const { signOut, signOutEverywhere } = useAuth();
  const { user, offline } = useData();
  const push = usePushService();
  const [busy, setBusy] = useState<SignOutScope | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<SignOutPrompt | null>(null);
  const [notEmpty, setNotEmpty] = useState<{ pending: number; failed: number } | null>(null);

  async function run(
    scope: SignOutScope,
    choice: SignOutChoice | null = null,
  ): Promise<SignOutOutcome | null> {
    if (busy !== null) return null;
    setBusy(scope);
    setFailure(null);
    setNotEmpty(null);
    let outcome: SignOutOutcome;
    try {
      outcome = await signOutWithChoice(
        {
          user,
          queue: offline.queue,
          engine: offline.engine,
          factory: offlineSessions,
          identity: offlineIdentity,
          endSession: scope === 'device' ? signOut : signOutEverywhere,
          beforeEnd: async () => {
            await push?.unregister();
          },
        },
        choice,
      );
    } catch {
      setBusy(null);
      return null;
    }
    setBusy(null);
    if (outcome.ok) {
      setPrompt(null);
      // One user's session at a time: nobody is left for the background task to sync. The next
      // sign-in registers it again (SyncProvider).
      void unregisterBackgroundSync();
      return outcome;
    }
    if (outcome.reason === 'needsChoice') {
      setPrompt({ scope, pending: outcome.pending, failed: outcome.failed });
    } else if (outcome.reason === 'notEmpty') {
      setPrompt({ scope, pending: outcome.pending, failed: outcome.failed });
      setNotEmpty({ pending: outcome.pending, failed: outcome.failed });
    } else {
      setFailure(authFailureText(outcome.failure));
      // Still signed in (sign out everywhere was not confirmed): register the phone again.
      void push?.register();
    }
    return outcome;
  }

  function cancel(): void {
    setPrompt(null);
    setNotEmpty(null);
  }

  return { busy, failure, prompt, notEmpty, run, cancel };
}
