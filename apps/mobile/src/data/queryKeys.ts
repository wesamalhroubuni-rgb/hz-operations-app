// The keys of the read cache (TanStack Query). One place, so a write knows what to refresh.

export const queryKeys = {
  myTasks: ['me', 'tasks'] as const,
  task: (id: string) => ['task', id] as const,
  myLogs: ['me', 'logs'] as const,
  recentLogTypeUse: ['me', 'logs', 'recent'] as const,
  log: (id: string) => ['log', id] as const,
  attachments: (logId: string) => ['log', logId, 'attachments'] as const,
  logTypes: ['logTypes'] as const,
  sites: ['sites'] as const,
  teams: ['teams'] as const,
  scope: ['scope'] as const,
  organization: ['organization'] as const,
  notifications: ['notifications'] as const,
};
