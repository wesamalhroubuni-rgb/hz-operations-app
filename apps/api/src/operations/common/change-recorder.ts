import { Injectable } from '@nestjs/common';
import { AuditService } from '../../platform/audit/audit.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import type { Db } from './db';

/** Entity types of the Operations domain, as written to the audit log and the outbox. */
export type EntityType =
  | 'organization'
  | 'user'
  | 'membership'
  | 'site'
  | 'team'
  | 'log_type'
  | 'task'
  | 'work_log'
  | 'attachment';

/** Key under which the entity sits in an outbox payload. */
const PAYLOAD_KEYS: Record<EntityType, string> = {
  organization: 'organization',
  user: 'user',
  membership: 'membership',
  site: 'site',
  team: 'team',
  log_type: 'logType',
  task: 'task',
  work_log: 'workLog',
  attachment: 'attachment',
};

export interface RecordedChange {
  organizationId: string;
  entityType: EntityType;
  /** Past-tense verb: `created`, `updated`, `archived`, `restored`, `status_changed`, ... */
  verb: string;
  entityId: string;
  /** Wire-shape state before the change. Omit on create. */
  before?: unknown;
  /** Wire-shape state after the change. */
  after: unknown;
  /** Extra facts for the event payload, for example `{ from, to }` of a status change. */
  extra?: Record<string, unknown>;
  /**
   * Facts about how the change was made, merged into the audit event's `metadata` over the
   * offline-sync facts the platform adds (ADR-0008), e.g. `{ droppedReferences: ['taskId'] }`.
   */
  auditMetadata?: Record<string, unknown>;
}

/**
 * Writes the audit event and the outbox event of one change, both named
 * `<entityType>.<verb>`. Every domain service calls this inside the transaction of the change,
 * so the record, its audit row and its event commit or roll back together.
 *
 * The outbox payload is `{ ...extra, <entity>: after }`: the entity in its wire shape under its
 * camelCase name (`site`, `workLog`, `logType`, ...), so a consumer does not need to re-read it.
 */
@Injectable()
export class ChangeRecorder {
  constructor(
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async record(tx: Db, change: RecordedChange): Promise<void> {
    const name = `${change.entityType}.${change.verb}`;
    await this.audit.record(tx, {
      organizationId: change.organizationId,
      action: name,
      entityType: change.entityType,
      entityId: change.entityId,
      before: change.before,
      after: change.after,
      ...(change.auditMetadata ? { metadata: change.auditMetadata } : {}),
    });
    await this.outbox.publish(tx, {
      organizationId: change.organizationId,
      eventType: name,
      aggregateType: change.entityType,
      aggregateId: change.entityId,
      payload: { ...change.extra, [PAYLOAD_KEYS[change.entityType]]: change.after },
    });
  }
}
