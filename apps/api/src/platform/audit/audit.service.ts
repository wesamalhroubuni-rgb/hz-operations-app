/**
 * Audit log writer (reusable platform component).
 *
 * Host requirements: a database client (or transaction) with an `auditEvent` table shaped like
 * `AuditWriter` below, and `RequestContext` for the actor and the correlation id. Nothing else:
 * the service has no injected dependencies and can be constructed with `new AuditService()`.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContext, type OfflineSyncInfo } from '../request-context/request-context';
import {
  DEFAULT_REDACTED_KEY_PATTERN,
  diffSnapshots,
  redactChanges,
  redactSnapshot,
  toJsonSnapshot,
  type RedactionRules,
} from './audit-snapshot';

/** What a caller states about a change. Actor, correlation id and time are added here. */
export interface AuditRecordInput {
  organizationId: string | null;
  /** Dotted action name: `<entity>.<verb>`, for example `site.created`, `task.archived`. */
  action: string;
  entityType: string;
  entityId: string;
  /** State before the change. Omit on create. */
  before?: unknown;
  /** State after the change. Omit when the record is gone. */
  after?: unknown;
  /**
   * Extra key names whose values must not be stored, on top of the service-wide rules
   * (passwords, tokens, secrets, ...). Compared case-insensitively, at any depth.
   */
  redact?: readonly string[];
  /**
   * Facts about how the change was made, merged over the platform's own (the offline-sync facts
   * of the request, ADR-0008), for example `droppedReferences`. Stored in `metadata`.
   */
  metadata?: Record<string, unknown>;
}

/** The slice of a database client (or transaction) the audit log writes through. */
export interface AuditWriter {
  auditEvent: {
    create(args: {
      data: {
        organizationId: string | null;
        actorType: 'user' | 'system';
        actorId: string | null;
        action: string;
        entityType: string;
        entityId: string;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON column
        before?: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON column
        after?: any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON column
        changes?: any;
        correlationId: string | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON column
        metadata?: any;
      };
    }): PromiseLike<unknown>;
  };
}

/**
 * The `metadata` of an audit event: for a request from an offline queue
 * `{ via: 'offline_sync', deviceTime, serverTime, clockSkewSeconds }` (`auditMetadataSchema` in
 * @ops/shared) with the caller's own facts merged over it; the caller's facts alone otherwise;
 * null when there is nothing to say.
 */
export function auditMetadataOf(
  offline: OfflineSyncInfo | null,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!offline) {
    return extra && Object.keys(extra).length > 0 ? { ...extra } : null;
  }
  return {
    via: 'offline_sync',
    deviceTime: offline.deviceTime,
    serverTime: offline.serverTime.toISOString(),
    clockSkewSeconds: offline.clockSkewSeconds,
    ...extra,
  };
}

/** Optional service-wide settings. Provide them under `AUDIT_OPTIONS` to change the defaults. */
export interface AuditOptions {
  /** Replaces the default pattern of sensitive key names. */
  redactKeyPattern?: RegExp;
  /** Extra exact key names (case-insensitive) to redact in every event. */
  redactKeys?: readonly string[];
}

export const AUDIT_OPTIONS = Symbol('platform.auditOptions');

/**
 * The only way audit events are written. Pass the transaction client of the change being
 * recorded, so the audit row commits or rolls back together with it.
 *
 * Every call writes exactly one row. `before` and `after` are stored as JSON-safe copies with
 * sensitive values replaced by "[redacted]". `changes` is the field-level diff when both sides
 * are given (`{}` when nothing differs) and is left empty (null) otherwise.
 */
@Injectable()
export class AuditService {
  private readonly pattern: RegExp;
  private readonly keys: readonly string[];

  constructor(@Optional() @Inject(AUDIT_OPTIONS) options?: AuditOptions) {
    this.pattern = options?.redactKeyPattern ?? DEFAULT_REDACTED_KEY_PATTERN;
    this.keys = options?.redactKeys ?? [];
  }

  async record(tx: AuditWriter, input: AuditRecordInput): Promise<void> {
    const actor = RequestContext.actor();
    const rules: RedactionRules = {
      pattern: this.pattern,
      keys: [...this.keys, ...(input.redact ?? [])],
    };

    // Diff the real values first, then redact, so a changed secret still shows up as changed.
    const rawBefore = toJsonSnapshot(input.before);
    const rawAfter = toJsonSnapshot(input.after);
    const rawChanges = diffSnapshots(rawBefore, rawAfter);

    const before = redactSnapshot(rawBefore, rules);
    const after = redactSnapshot(rawAfter, rules);
    const changes = rawChanges === null ? null : redactChanges(rawChanges, rules);
    const metadata = auditMetadataOf(RequestContext.offlineSync(), input.metadata);

    await tx.auditEvent.create({
      data: {
        organizationId: input.organizationId,
        actorType: actor ? 'user' : 'system',
        actorId: actor?.userId ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId,
        ...(before === undefined ? {} : { before }),
        ...(after === undefined ? {} : { after }),
        ...(changes === null ? {} : { changes }),
        correlationId: RequestContext.correlationId(),
        ...(metadata === null ? {} : { metadata }),
      },
    });
  }
}
