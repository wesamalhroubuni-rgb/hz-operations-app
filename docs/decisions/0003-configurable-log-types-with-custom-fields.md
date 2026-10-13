# ADR-0003: Configurable log types with custom fields

- **Status**: Accepted
- **Date**: 2026-10-13
- **Phase**: 2 (Backend core)

## Context

Workers record different kinds of work: an inspection, a delivery, material used for a job. Each
kind needs its own structured fields (a result, a supplier, a quantity and unit). The client does
not yet know the full list and must be able to add a new kind of input, or a new field, without a
code change or a database migration.

The values must still be validated, on the server and ideally in the web and mobile forms before a
request is sent, and a work log written under an older definition must stay readable after the
definition changes.

## Decision

**Definitions live on the log type, as JSON.** `LogType` is a per-organization record with a
stable `key`, a `name`, and `fields`: an ordered JSON array of custom field definitions. One
definition is:

| Property   | Meaning                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `key`      | Stable slug (`^[a-z][a-z0-9_]{0,63}$`), unique within the log type. Values are stored under it. |
| `label`    | What people see. May change freely.                                                             |
| `type`     | `text`, `number`, `boolean`, `select`, or `date`.                                               |
| `required` | Defaults to false.                                                                              |
| `options`  | Required and non-empty for `select`, forbidden for every other type.                            |
| `helpText` | Optional hint for the form.                                                                     |

A log type has at most 100 fields, and a select has at most 100 options.

**Versioning.** `LogType.version` starts at 1 and goes up by one each time `fields` is sent and
differs from the stored definition. Changing only the name or description does not change it.

**Values live on the work log, as JSON.** `WorkLog.customFields` is a JSON object keyed by field
key. `WorkLog.logTypeVersion` stores the log type version the values were validated against (null
when the log has no log type).

**One validator, in the shared package.** `validateCustomFieldValues(definitions, values)` in
`@ops/shared` (`src/domain/custom-fields.ts`) is the only implementation of the rules. The API
runs it on every work log create, and on every update that sends `logTypeId` or `customFields`.
The web and mobile apps can call the same function to validate a form. The rules:

- a key that no definition declares is rejected;
- a required field must be present and not null (and, for text, not blank);
- an optional field may be absent or null, which both mean "no value" and are not stored;
- text is a string of at most 2000 characters, number is a finite number, boolean is a boolean,
  select is one of the options, date is an ISO date (`2026-10-13`) or an ISO datetime with an
  offset;
- a work log without a log type must have empty custom fields.

Every problem is reported at once, with `path` set to `customFields.<key>`.

**The log type `key` is immutable**; there is no way to send it in an update. Log types are
archived, not deleted, and existing logs keep their type.

## Reasons

- **No migration to add a kind of input.** A new log type or field is one API call by an admin.
- **One query reads a work log.** The values arrive with the row; there is no join per field.
- **The contract is defined once.** The API, the dashboard, and the worker app validate with the
  same function, so a form cannot accept what the server rejects.
- **The version makes old logs interpretable.** A log states which definition it satisfied, so a
  later change to the definition does not make it look invalid.
- **PostgreSQL JSON columns are well supported** by Prisma and can be indexed later if reporting
  needs it.

## Tradeoffs

- **The database does not know the fields.** There are no column types, constraints, or foreign
  keys on custom values. Correctness depends on every write going through the validator.
- **Old definitions are not stored.** Only the current `fields` is kept on the log type. The
  definition that an older `logTypeVersion` refers to can be recovered only from the audit log
  (the `before` and `after` of `log_type.updated` events).
- **Existing logs are not migrated or re-validated** when a definition changes. A field removed
  from the type stays in older logs; a field made required is missing from them. Editing such a
  log's custom fields re-validates it against the current definition and can therefore fail until
  the values are brought up to date.
- **Querying and reporting on a custom field needs JSON operators.** Filtering work logs by a
  custom value is not offered by the API, and doing it efficiently will need expression or GIN
  indexes.
- **Renaming a field key is not supported.** Changing a `key` is, to the validator, removing one
  field and adding another; the old values are orphaned.
- **Field keys interact with audit redaction.** The audit log and the outbox replace the value of
  any key that looks sensitive, at any depth, with `"[redacted]"`. The pattern matches key names
  containing `password`, `passphrase`, `passcode`, `secret`, `token`, `api_key`, `credential`, or
  `authorization`, and names ending in `hash`. A custom field keyed `token_no` or `batch_hash` is
  therefore redacted in audit and outbox events while the work log itself keeps the value.
- **Five field types only.** There is no multi-select, attachment, reference, or computed field.

## Alternatives considered

| Alternative                                              | Why not                                                                                                                                                                                                                                               |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entity-attribute-value tables (field table, value table) | Relational and indexable per field, but every read of a work log becomes a join over many rows, values need one column per type or text casting, and writes touch many rows. The reporting need that would justify it is not here yet.                |
| One table per log type                                   | Real columns and constraints, but each new kind of input is a migration and a deployment, which is exactly what the client must not need.                                                                                                             |
| A JSON Schema stored per log type                        | Standard and more expressive, but it needs a JSON Schema validator in the API, the browser, and React Native, and a form builder would have to interpret arbitrary schemas. Five known field types cover the need and render directly as form inputs. |
| A version-history table for log type definitions         | Would make every old definition directly readable. Deferred: the audit log already holds each change, and nothing yet reads old definitions. Add it when reporting or re-validation needs them.                                                       |
| Free-form JSON with no definitions                       | No validation, no form generation, and no consistent data to summarise later.                                                                                                                                                                         |

## Consequences

- Add a field type by extending `CUSTOM_FIELD_TYPES` and `validateCustomFieldValues` in
  `@ops/shared`; the API and both clients pick it up together. `custom-fields.test.ts` must cover
  it.
- Never write `WorkLog.customFields` except through `WorkLogsService`, which runs the validator
  and records `logTypeVersion`.
- Advise admins not to use field keys that look like secrets (see the redaction tradeoff), or
  change the redaction rule; today the form does not warn about it.
- When reporting on custom fields is required (Phase 6 or 7), decide between JSON indexes and a
  derived, typed projection, and decide whether a version-history table is needed. That decision
  needs its own ADR.
- The AI layer (Phase 7) reads custom values through outbox events, where redacted keys are
  already replaced. Smart capture must produce values that pass the same validator.
