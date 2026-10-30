'use client';

import type { AuthUser } from '@ops/shared';
import { useMemo } from 'react';

import { useAuth } from '@/components/auth-provider';
import { canReviewWorkLog, capabilitiesFor, type Capabilities } from '@/lib/permissions';

export interface Caller {
  /** The signed-in user (`GET /auth/me`). */
  user: AuthUser;
  capabilities: Capabilities;
  isSelf(userId: string | null | undefined): boolean;
  /** Offer Approve / Reject for this log? Never for the caller's own log. */
  canReview(log: { authorId: string; status: string; archivedAt: string | null }): boolean;
}

/**
 * The signed-in user and what their role lets the dashboard offer (UX only: the API enforces
 * every rule). Only usable below the app shell, which renders pages for signed-in users only;
 * it throws elsewhere, which is a programming error.
 */
export function useCaller(): Caller {
  const { state } = useAuth();
  const user = state.status === 'signedIn' ? state.user : null;
  const caller = useMemo<Caller | null>(() => {
    if (user === null) {
      return null;
    }
    const capabilities = capabilitiesFor(user.roles);
    return {
      user,
      capabilities,
      isSelf: (userId) => userId === user.id,
      canReview: (log) => canReviewWorkLog(capabilities, user.id, log),
    };
  }, [user]);
  if (caller === null) {
    throw new Error('useCaller is only available on signed-in pages');
  }
  return caller;
}
