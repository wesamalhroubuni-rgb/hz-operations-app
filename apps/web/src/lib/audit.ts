import {
  AUDIT_REDACTED,
  auditMetadataSchema,
  type AuditEvent,
  type AuditMetadata,
} from '@ops/shared';

/**
 * Audit log screen logic (Phase 6, agent C; admins only, `GET /audit-events`). Pure, so tested.
 * The API already redacts sensitive keys (`"[redacted]"`) at any depth; the screen shows that
 * marker as such and never tries to reveal anything.
 */

/** The URL / API filters of the audit list (names of `listAuditEventsQuerySchema`). */
export const AUDIT_FILTER_KEYS = [
  'actorId',
  'entityType',
  'entityId',
  'action',
  'correlationId',
  'from',
  'to',
] as const;

/** Entity types the API writes audit events for (the filter's choices). */
export const AUDIT_ENTITY_TYPES = [
  'organization',
  'user',
  'membership',
  'site',
  'team',
  'log_type',
  'task',
  'work_log',
  'attachment',
  'export',
] as const;

export interface AuditDiffRow {
  field: string;
  from: string;
  to: string;
  /** One side is the redaction marker (or contains it). */
  redacted: boolean;
}

/** A stored value as one line of text: JSON for objects and arrays, `—` for null / missing. */
export function formatAuditValue(value: unknown, empty = '—'): string {
  if (value === undefined || value === null) return empty;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function containsRedaction(value: unknown): boolean {
  if (value === AUDIT_REDACTED) return true;
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).some(containsRedaction);
  }
  return false;
}

/** The `changes` of an event as rows sorted by field name (empty on create / no changes). */
export function auditDiffRows(event: Pick<AuditEvent, 'changes'>, empty = '—'): AuditDiffRow[] {
  if (!event.changes) return [];
  return Object.entries(event.changes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([field, change]) => ({
      field,
      from: formatAuditValue(change.from, empty),
      to: formatAuditValue(change.to, empty),
      redacted: containsRedaction(change.from) || containsRedaction(change.to),
    }));
}

/** The offline-sync metadata of an event (ADR-0008), or null for an ordinary request. */
export function offlineSyncOf(event: Pick<AuditEvent, 'metadata'>): AuditMetadata | null {
  if (!event.metadata) return null;
  const parsed = auditMetadataSchema.safeParse(event.metadata);
  return parsed.success ? parsed.data : null;
}

/** The record before or after, pretty-printed for the detail view. */
export function prettyJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** The first part of an id, for a narrow column (the full id is in the detail). */
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
