import { attachmentsEndpoints } from '../domain/attachments.js';
import { logTypesEndpoints } from '../domain/log-types.js';
import { membershipsEndpoints } from '../domain/memberships.js';
import { organizationEndpoints } from '../domain/organization.js';
import { scopeEndpoints } from '../domain/scope.js';
import { sitesEndpoints } from '../domain/sites.js';
import { tasksEndpoints } from '../domain/tasks.js';
import { teamsEndpoints } from '../domain/teams.js';
import { usersEndpoints } from '../domain/users.js';
import { workLogsEndpoints } from '../domain/work-logs.js';
import { auditEventsEndpoints } from '../platform/audit.js';
import { outboxEventsEndpoints } from '../platform/outbox.js';
import { createApiTransport, healthEndpoints, type ApiClientOptions } from './client.js';

export * from './client.js';
export * from './health-monitor.js';
export * from './health-status.js';

/**
 * The typed API client used by the web and mobile apps.
 *
 * Pattern: one transport, plus one small "endpoints" function per resource that maps methods to
 * `transport.request({ path, schema, ... })`. To add a resource, write `xxxEndpoints(transport)`
 * next to its schemas and add it to the object below.
 */
export function createApiClient(options: ApiClientOptions) {
  const transport = createApiTransport(options);
  return {
    transport,
    health: healthEndpoints(transport),
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
    auditEvents: auditEventsEndpoints(transport),
    outboxEvents: outboxEventsEndpoints(transport),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
