import { attachmentsEndpoints } from '../domain/attachments.js';
import { logTypesEndpoints } from '../domain/log-types.js';
import { membershipsEndpoints } from '../domain/memberships.js';
import { organizationEndpoints } from '../domain/organization.js';
import { scopeEndpoints } from '../domain/scope.js';
import { sitesEndpoints } from '../domain/sites.js';
import { syncEndpoints } from '../domain/sync.js';
import { tasksEndpoints } from '../domain/tasks.js';
import { teamsEndpoints } from '../domain/teams.js';
import { usersEndpoints } from '../domain/users.js';
import { workLogsEndpoints } from '../domain/work-logs.js';
import { auditEventsEndpoints } from '../platform/audit.js';
import { authEndpoints } from '../platform/auth.js';
import { notificationsEndpoints } from '../platform/notifications.js';
import { outboxEventsEndpoints } from '../platform/outbox.js';
import { createApiTransport, healthEndpoints, type ApiClientOptions } from './client.js';

/**
 * The typed API client used by the web and mobile apps.
 *
 * Pattern: one transport, plus one small "endpoints" function per resource that maps methods to
 * `transport.request({ path, schema, ... })`. To add a resource, write `xxxEndpoints(transport)`
 * next to its schemas and add it to the object below.
 *
 * The apps do not call this directly for authenticated work: `createAuthSessionManager` builds the
 * client with the hooks that attach the session and renew it.
 */
export function createApiClient(options: ApiClientOptions) {
  const transport = createApiTransport(options);
  return {
    transport,
    health: healthEndpoints(transport),
    auth: authEndpoints(transport),
    organization: organizationEndpoints(transport),
    users: usersEndpoints(transport),
    memberships: membershipsEndpoints(transport),
    sites: sitesEndpoints(transport),
    teams: teamsEndpoints(transport),
    logTypes: logTypesEndpoints(transport),
    tasks: tasksEndpoints(transport),
    workLogs: workLogsEndpoints(transport),
    attachments: attachmentsEndpoints(transport),
    scope: scopeEndpoints(transport),
    sync: syncEndpoints(transport),
    notifications: notificationsEndpoints(transport),
    auditEvents: auditEventsEndpoints(transport),
    outboxEvents: outboxEventsEndpoints(transport),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
