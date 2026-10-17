import { useState } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { authFailureText } from '../i18n/authText';
import { usePushService } from '../push/usePush';

export type SignOutScope = 'device' | 'everywhere';

/**
 * Runs "Sign out" and "Sign out everywhere". This phone's push token is removed first, while the
 * session can still authorise it (the API also drops tokens of ended sessions, so a failure here
 * is harmless). On success the app switches to the sign-in screen, so only a failure has anything
 * to report here.
 */
export function useSignOut() {
  const { signOut, signOutEverywhere } = useAuth();
  const push = usePushService();
  const [busy, setBusy] = useState<SignOutScope | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(scope: SignOutScope): Promise<void> {
    if (busy !== null) {
      return;
    }
    setBusy(scope);
    setFailure(null);
    await push?.unregister();
    const result = await (scope === 'device' ? signOut() : signOutEverywhere());
    if (!result.ok) {
      setBusy(null);
      setFailure(authFailureText(result.failure));
      // Still signed in (sign out everywhere was not confirmed): register the phone again.
      void push?.register();
    }
  }

  return { busy, failure, run };
}
