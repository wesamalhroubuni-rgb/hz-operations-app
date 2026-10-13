/**
 * Pure helpers that turn the before/after state of a record into what the audit log stores:
 * JSON-safe copies, a field-level diff, and redaction of sensitive values. No dependencies.
 */
import { AUDIT_REDACTED } from '@ops/shared';

export type JsonObject = Record<string, unknown>;

export interface FieldChange {
  from: unknown;
  to: unknown;
}

export type FieldChanges = Record<string, FieldChange>;

/**
 * Keys whose values never reach the audit log, wherever they sit in the record: passwords and
 * passphrases, secrets, tokens, API keys, credentials, authorization headers, and any `...Hash`.
 */
export const DEFAULT_REDACTED_KEY_PATTERN =
  /pass(word|phrase|code)|secret|token|api[-_]?key|credential|authorization|hash$/i;

export interface RedactionRules {
  /** Keys matching this pattern are redacted. */
  pattern: RegExp;
  /** Extra exact key names (compared case-insensitively) to redact. */
  keys: readonly string[];
}

export function isRedactedKey(key: string, rules: RedactionRules): boolean {
  if (rules.pattern.test(key)) {
    return true;
  }
  const lower = key.toLowerCase();
  return rules.keys.some((name) => name.toLowerCase() === lower);
}

/**
 * Plain JSON copy of a value: dates become ISO strings, BigInt becomes a decimal string, objects
 * with `toJSON` (decimals) use it, `undefined` properties are dropped. `undefined` and `null`
 * both come back as `undefined`, meaning "there is no state on this side".
 */
export function toJsonSnapshot(value: unknown): unknown {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
  return text === undefined ? undefined : (JSON.parse(text) as unknown);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural equality of two JSON values. Object key order does not matter. */
export function jsonEquals(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => jsonEquals(item, right[index]))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    return (
      leftKeys.length === Object.keys(right).length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEquals(left[key], right[key]))
    );
  }
  return false;
}

/**
 * Field-level diff of two JSON snapshots: `{ field: { from, to } }` for every top-level key whose
 * value differs (nested values are compared deeply, and reported whole). A key missing on one
 * side is reported as `null` on that side. Returns null when either side is not an object, which
 * is the case on create and on hard delete; returns `{}` when nothing changed.
 */
export function diffSnapshots(before: unknown, after: unknown): FieldChanges | null {
  if (!isJsonObject(before) || !isJsonObject(after)) {
    return null;
  }
  const changes: FieldChanges = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of [...keys].sort()) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (!jsonEquals(from, to)) {
      changes[key] = { from, to };
    }
  }
  return changes;
}

/** Copy of a JSON value with the value of every sensitive key, at any depth, replaced. */
export function redactSnapshot(value: unknown, rules: RedactionRules): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSnapshot(item, rules));
  }
  if (isJsonObject(value)) {
    const copy: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      copy[key] = isRedactedKey(key, rules) ? AUDIT_REDACTED : redactSnapshot(item, rules);
    }
    return copy;
  }
  return value;
}

/**
 * Redacts a diff. A sensitive field that changed stays in the diff, so the log shows that it
 * changed, but with both values replaced.
 */
export function redactChanges(changes: FieldChanges, rules: RedactionRules): FieldChanges {
  const copy: FieldChanges = {};
  for (const [key, change] of Object.entries(changes)) {
    copy[key] = isRedactedKey(key, rules)
      ? { from: AUDIT_REDACTED, to: AUDIT_REDACTED }
      : { from: redactSnapshot(change.from, rules), to: redactSnapshot(change.to, rules) };
  }
  return copy;
}
