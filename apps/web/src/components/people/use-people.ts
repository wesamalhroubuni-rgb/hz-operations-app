'use client';

import type { AuthSession, Membership, Paginated, User } from '@ops/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { requireApiClient } from '@/lib/api/client';
import { unwrap } from '@/lib/api/errors';
import { queryKeys } from '@/lib/api/query';

/** `GET /users` with the URL's list query. */
export function useUserList(query: Record<string, string | number>) {
  return useQuery<Paginated<User>>({
    queryKey: queryKeys.users.list(query),
    queryFn: async () => unwrap(await requireApiClient().users.list(query)),
    placeholderData: keepPreviousData,
  });
}

export function useUser(id: string) {
  return useQuery<User>({
    queryKey: queryKeys.users.detail(id),
    queryFn: async () => unwrap(await requireApiClient().users.get(id)),
  });
}

/** Active memberships of one user (admins only: `membership.read`). */
export function useUserMemberships(userId: string, enabled: boolean) {
  const query = { userId, pageSize: 100 };
  return useQuery<Paginated<Membership>>({
    queryKey: queryKeys.memberships.list(query),
    queryFn: async () => unwrap(await requireApiClient().memberships.list(query)),
    enabled,
  });
}

/** `GET /users/:id/sessions` (admins only). Never contains a token. */
export function useUserSessions(userId: string, enabled: boolean) {
  return useQuery<{ items: AuthSession[] }>({
    queryKey: queryKeys.users.sessions(userId),
    queryFn: async () => unwrap(await requireApiClient().users.sessions(userId)),
    enabled,
  });
}

/** After a people write: refresh users, memberships, the directory (names, roles). */
export function usePeopleChanged() {
  const queryClient = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.users.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.memberships.all }),
      queryClient.invalidateQueries({ queryKey: queryKeys.directory }),
    ]);
  }, [queryClient]);
}
