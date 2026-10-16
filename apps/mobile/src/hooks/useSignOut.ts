import { useState } from 'react';

import { useAuth } from '../auth/AuthProvider';

export type SignOutScope = 'device' | 'everywhere';

/**
 * Runs "Sign out" and "Sign out everywhere". On success the app switches to the sign-in screen,
 * so only a failure has anything to report here.
 */
export function useSignOut() {
  const { signOut, signOutEverywhere } = useAuth();
  const [busy, setBusy] = useState<SignOutScope | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function run(scope: SignOutScope): Promise<void> {
    if (busy !== null) {
      return;
    }
    setBusy(scope);
    setFailure(null);
    const result = await (scope === 'device' ? signOut() : signOutEverywhere());
    if (!result.ok) {
      setBusy(null);
      setFailure(result.failure.message);
    }
  }

  return { busy, failure, run };
}
