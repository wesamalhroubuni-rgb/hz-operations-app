'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { createQueryClient } from '@/lib/api/query';

import { useAuth } from './auth-provider';

/**
 * One TanStack Query cache per tab (ADR-0009). Emptied whenever nobody is signed in, so the
 * next user of the browser never sees the previous user's cached data, even for an instant.
 */
export function QueryProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [queryClient] = useState(createQueryClient);
  const { state } = useAuth();
  const userId = state.status === 'signedIn' ? state.user.id : null;

  useEffect(() => {
    if (userId === null) {
      queryClient.clear();
    }
  }, [queryClient, userId]);

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
