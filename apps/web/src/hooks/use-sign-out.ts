'use client';

import { useState } from 'react';

import { useAuth } from '@/components/auth-provider';

export type SignOutScope = 'device' | 'everywhere';

/**
 * Runs "Sign out" and "Sign out everywhere". On success the route guard takes the user to the
 * sign-in page, so only a failure has anything to report here.
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
