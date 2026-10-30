import { QueryClient } from '@tanstack/react-query';

import { shouldRetry } from './errors';

/**
 * Data fetching (ADR-0009): TanStack Query over the typed `apiClient`. One `QueryClient` per
 * browser tab (created in `QueryProvider`), never shared between users: signing out clears it.
 *
 * - `staleTime` 30 s: lists refresh on focus and on navigation back, not on every render.
 * - Retries only for failures that may pass by themselves (network, timeout, 429, 5xx); a 4xx is
 *   final, so a 404 (outside scope) shows at once.
 * - Mutations never retry (a write is not repeated without the user).
 * - Optimistic updates only where a refusal cannot surprise (marking read, toggles the user
 *   owns); approvals, assignments and settings wait for the server's answer, then invalidate.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: shouldRetry,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Query keys, one factory per resource, so a mutation invalidates exactly the right lists:
 * `queryClient.invalidateQueries({ queryKey: queryKeys.workLogs.all })` after an approval.
 * Screen agents add keys for their resources here in their own block (agent B: workLogs,
 * dashboard, map, reports; agent C: tasks, users, memberships, sites, teams, logTypes, audit,
 * organization).
 */
export const queryKeys = {
  me: ['me'] as const,
  organization: ['organization'] as const,
  directory: ['directory'] as const,
  dashboard: {
    all: ['dashboard'] as const,
    overview: (day: string | null) => ['dashboard', 'overview', day] as const,
  },
  workLogs: {
    all: ['workLogs'] as const,
    list: (query: Record<string, unknown>) => ['workLogs', 'list', query] as const,
    detail: (id: string) => ['workLogs', 'detail', id] as const,
    history: (id: string) => ['workLogs', 'history', id] as const,
    attachments: (id: string) => ['workLogs', 'attachments', id] as const,
    map: (query: Record<string, unknown>) => ['workLogs', 'map', query] as const,
  },
  reports: {
    workLogs: (query: Record<string, unknown>) => ['reports', 'workLogs', query] as const,
  },
  tasks: {
    all: ['tasks'] as const,
    list: (query: Record<string, unknown>) => ['tasks', 'list', query] as const,
    detail: (id: string) => ['tasks', 'detail', id] as const,
    history: (id: string) => ['tasks', 'history', id] as const,
  },
  users: {
    all: ['users'] as const,
    list: (query: Record<string, unknown>) => ['users', 'list', query] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
    sessions: (id: string) => ['users', 'sessions', id] as const,
  },
  memberships: {
    all: ['memberships'] as const,
    list: (query: Record<string, unknown>) => ['memberships', 'list', query] as const,
  },
  sites: {
    all: ['sites'] as const,
    list: (query: Record<string, unknown>) => ['sites', 'list', query] as const,
  },
  teams: {
    all: ['teams'] as const,
    list: (query: Record<string, unknown>) => ['teams', 'list', query] as const,
  },
  logTypes: {
    all: ['logTypes'] as const,
    list: (query: Record<string, unknown>) => ['logTypes', 'list', query] as const,
    detail: (id: string) => ['logTypes', 'detail', id] as const,
  },
  audit: {
    all: ['audit'] as const,
    list: (query: Record<string, unknown>) => ['audit', 'list', query] as const,
  },
} as const;
