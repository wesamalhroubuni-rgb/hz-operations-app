# ADR-0008: Offline storage, sync, and conflict rules

- **Status**: Accepted
- **Date**: 2026-10-27
- **Phase**: 5 (Offline mode and sync)
- **Amends**: [ADR-0005](0005-authorization-model.md) in part (typed refusal codes) and
  [ADR-0006](0006-file-storage-and-upload-flow.md) in part (late photos of a log's original
  submission, section 5)

## Context

The owner's Phase 5 prompt (`docs/prompts/phase-5.md`) asks that a worker can use the phone app
fully offline for their own work (see their tasks, create and edit logs with photos and location,
change task status) and that everything syncs automatically and safely when the connection
returns, with nothing lost and nothing duplicated. It recommends the conflict rules (server is the
source of truth, late offline logs accepted, the edit window judged at sync time, the supervisor's
change wins) and asks for this ADR, a sequence diagram, and an emulator test plan, because the
owner's PC is Ethernet-only and no real phone can reach it yet.

What exists before this phase: work-log creates are idempotent by `clientId` (Phase 2); a
four-step photo upload with a resumable checkpoint (ADR-0006); a Phase 4 upload queue in
AsyncStorage that is deleted after 14 days; screens that write only through
`apps/mobile/src/data/repositories.ts`; organization settings as a JSON column with typed keys
(`workLogEditWindowHours`); no row versions; no idempotency for edits; no delta read.

This ADR fixes the contracts (database, `@ops/shared`, `apps/mobile/src/offline/types.ts`) that
the backend, the mobile store and queue, and the sync engine are built against.

## Before building (AGENTS.md statement)

1. **Business objective.** Workers with weak or no signal keep working; supervisors receive every
   log exactly once, with honest times, and nothing a worker did is silently lost.
2. **Expected behaviour.** Reads come from a per-user local cache refreshed by `GET /sync/pull`
   ("last refreshed" shown). Writes (create and edit a log, submit a draft, change a task's
   status, attach photos) go into a per-user local queue and answer at once; the queue is sent
   when the network returns, when the app comes to the foreground, on "Sync now", after a write,
   and in the background where the OS allows. Each record's writes are sent in order, retried
   with backoff, and made idempotent by `clientId` and `Idempotency-Key`. The server judges each
   write with the Phase 3 rules; a refusal stays visible with its reason and the worker can
   retry, copy, resubmit as a new log, or discard. A small indicator shows synced / pending N /
   failed N / offline / sign in needed.
3. **Components affected.** API: Prisma schema and migration, `src/platform/idempotency/` (new),
   request context and `AuditService` (offline metadata), work-log, task and attachment services
   and rules (versions, typed codes, offline fields, declared photos, backdating limit), a new
   `sync` module (`GET /sync/pull`, policy `sync.pull`), organization summary. Shared: error
   codes, headers, sync schemas, body and response fields. Mobile: `src/offline/` (SQLite store,
   queue, photo store, sync engine), offline repositories behind `src/data/repositories.ts`, the
   auth provider (offline start, sign in again, user switch, sign-out warning), sync status UI,
   i18n messages per error code.
4. **Data required.** Row `version` on `Task` and `WorkLog`; `WorkLog.submittedOffline`,
   `deviceCreatedAt`, `clockSkewSeconds`, `declaredAttachmentClientIds`; `Attachment.clientId`;
   `AuditEvent.metadata`; table `IdempotencyRecord`; organization setting
   `offlineMaxBackdateDays`. On the phone: one SQLite database per user and a photo folder per
   user.
5. **External integrations.** None new on the server. On the phone: `expo-sqlite`,
   `@react-native-community/netinfo`, `expo-background-task` (all Expo SDK 57 versions),
   `expo-file-system` (existing).
6. **Failure cases.** No network or timeouts mid-request; the app killed mid-send (after the
   server committed but before the answer arrived); double taps; the access token expiring and
   the refresh token expiring offline; another user signing in on the same phone; the phone clock
   wrong by hours or days; a log approved, rejected, or edited elsewhere while the worker edits it
   offline; a task reassigned, cancelled, or changed by a supervisor meanwhile; a log kept offline
   longer than the backdating limit; the edit window closing before the photos arrive; a referenced
   task or site leaving the worker's scope; the local storage limit reached; the OS deleting a
   queued photo file; the server restarting while a request holds an idempotency key.
7. **Test plan.** See "Test plan" below.

## Decision

### 0. The flow: an offline log with photos

```mermaid
sequenceDiagram
    autonumber
    actor W as Worker
    participant UI as Screens
    participant R as Offline repositories
    participant Q as Queue + cache (SQLite ops-userId.db)
    participant P as Photo store (offline-photos/userId)
    participant E as Sync engine
    participant API as API
    participant S as Object storage

    Note over W,Q: No connection
    W->>UI: New log (text, custom fields, location) + 2 photos
    UI->>R: workLogs.create(body with clientId, attachmentClientIds [a1, a2])
    R->>P: save resized photos a1, a2
    R->>Q: enqueue createWorkLog (recordKey workLog:clientId)
    R->>Q: enqueue uploadAttachment a1, a2 (same recordKey)
    R-->>UI: { sync: 'pending' }: log shown as "waiting to send"
    Note over E: App restarted: sending items reset to pending

    Note over W,S: Connection returns (NetInfo), app foreground, or "Sync now"
    E->>Q: nextBatch(): oldest item per record
    E->>API: POST /work-logs + x-client-sync, x-device-time, idempotency-key
    API->>API: policy, own clientId? (replay 200), occurredAt within offlineMaxBackdateDays, references
    API->>API: one transaction: WorkLog (submittedOffline, clockSkewSeconds, declared ids) + ChangeRecorder (audit metadata via offline_sync, outbox)
    API-->>E: 201 WorkLog (version 1)
    E->>Q: markDone, cache the log, map clientId to id
    loop each photo (a1, a2)
        E->>API: POST /work-logs/:id/attachments { clientId: a1, ... }
        API->>API: normal rule OR declared + author + within 30 days
        API-->>E: 201 pending attachment + signed PUT URL (200 on repeat)
        E->>S: PUT bytes
        E->>API: POST /attachments/:id/complete
        API->>S: verify, re-encode to .verified., thumbnail
        API-->>E: 200 ready attachment
        E->>P: delete local photo
        E->>Q: markDone
    end
    E->>API: GET /sync/pull?cursor=...
    API-->>E: upserts + ids per resource, new cursor
    E->>Q: applyPull (prune by ids), lastRefreshedAt
    E-->>UI: status synced

    alt Server refuses (e.g. 422 occurred_at_out_of_range, 409 already_reviewed)
        API-->>E: typed error code
        E->>Q: failed_permanent, lastError {code, message, status}; later items of the record wait
        E-->>UI: status failed 1: worker can retry, copy, resubmit as new, or discard
    else Network drop or 5xx
        E->>Q: failed_retryable, nextAttemptAt (backoff with jitter)
    end
```

### 1. Server: optimistic concurrency

- `Task.version` and `WorkLog.version` (`Int`, default 1) are raised by 1 in the same transaction
  as **every** change of the row: content, status, review, assignees (a task's assignee change
  updates the task row, so its `version` and `updatedAt` move), archive and restore. Wire field
  `version` on `taskSchema` and `workLogSchema`.
- `expectedVersion` (optional, integer >= 1) is accepted on `updateWorkLogSchema`,
  `changeWorkLogStatusSchema` and `changeTaskStatusSchema`. Absent: no check (the online screens
  and the web keep working). Present and different from the row's version: **409
  `version_conflict`**, nothing changes, **unless the request changes nothing** (the status is
  already the requested one with the same reason or note; every field of an edit already has the
  sent value): then 200 with the current record. That makes a resend after a lost answer succeed.
- `expectedVersion` alone is not a field: an edit body still needs at least one other field.

### 2. Server: typed error codes

Added to `API_ERROR_CODES` with one status each (`API_ERROR_STATUS` in `@ops/shared`; throw them
with `ApiException.of(code, message, details?)`):

| Code                       | Status | When                                                                                                  |
| -------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| `version_conflict`         | 409    | `expectedVersion` differs (and the request is not a no-op).                                           |
| `edit_window_closed`       | 403    | The author's edit window passed (edit, author's status move, archive, photo outside the rules in 5).  |
| `already_reviewed`         | 409    | The author tries to change an approved log (was a generic 403).                                       |
| `record_archived`          | 409    | Change to an archived log, task or attachment (was a generic 409 `conflict`).                         |
| `task_not_assigned`        | 403    | Status change by a caller who sees the task but is neither an assignee nor its manager.               |
| `task_cancelled`           | 409    | An assignee changes a cancelled task (was a generic 403).                                             |
| `occurred_at_out_of_range` | 422    | `occurredAt` older than `offlineMaxBackdateDays` or more than 1 hour ahead (future was a 400 before). |
| `attachment_not_declared`  | 403    | A photo after the edit window whose clientId was not declared in the log's create.                    |
| `idempotency_key_reused`   | 422    | The same `Idempotency-Key` with a different method, path or body.                                     |
| `request_in_progress`      | 409    | The first request with this `Idempotency-Key` is still running. The only one of these worth retrying. |

Existing generic codes stay (`forbidden`, `not_found`, `conflict`, `unprocessable`,
`validation_failed`, ...). A worker who was unassigned from a task no longer sees it, so their
queued status change gets **404 `not_found`** (the 404-versus-403 rule of ADR-0005 is kept); the
phone shows "This task is no longer assigned to you". `RETRYABLE_API_ERROR_CODES` is
`rate_limited`, `service_unavailable`, `internal_error`, `request_in_progress`; `unauthenticated`
means "sign in again"; every other code is final for that request.

**Check order** (first failing check answers):

- **Edit a log** (`PATCH /work-logs/:id`): visible (404) → author (403 `forbidden`) → approved
  (409 `already_reviewed`) → edit window (403 `edit_window_closed`) → archived (409
  `record_archived`) → `expectedVersion` (409 `version_conflict`, unless no-op) → `occurredAt`
  range when changed (422 `occurred_at_out_of_range`) → references and custom fields (422 / 400).
- **Log status** (`PATCH /work-logs/:id/status`): visible (404) → same status and note = no-op 200
  → transition exists (409 `conflict`) → author rules as above or reviewer rules (403) → archived
  (409 `record_archived`) → `expectedVersion` (409).
- **Task status** (`PATCH /tasks/:id/status`): visible (404) → same status and reason = no-op 200
  → manager: allowed; else not an assignee (403 `task_not_assigned`), cancelled (409
  `task_cancelled`), status not allowed for an assignee (403 `forbidden`) → archived (409
  `record_archived`) → `expectedVersion` (409).
- **Create a log** (`POST /work-logs`): own existing `clientId` → 200 with the stored log, **before
  any other check** (a resend days later must not fail on the date) → `clientId` of somebody else
  (409 `conflict`) → `occurredAt` range (422) → references (below) → custom fields (400).

### 3. Server: offline-submission facts and the backdating limit

- Request headers (constants in `@ops/shared` `platform/offline-sync.ts`): `x-client-sync:
offline` (`CLIENT_SYNC_HEADER`, `CLIENT_SYNC_OFFLINE`) on every write sent by the queue;
  `x-device-time: <ISO>` (`DEVICE_TIME_HEADER`), the phone's clock at sending;
  `idempotency-key: <uuid>` (`IDEMPOTENCY_KEY_HEADER`). Build them with `offlineSyncHeaders()`
  and pass them as `options.headers` to the write endpoints (`ApiCallOptions`).
- The platform request-context middleware reads the two sync headers into the request store
  (offline flag, device time, server receive time). `AuditService.record` (platform) writes
  `AuditEvent.metadata = { via: 'offline_sync', deviceTime, serverTime, clockSkewSeconds }`
  (`auditMetadataSchema`) for every audit row of such a request; `AuditRecordInput` gains an
  optional `metadata` merged over it (for `droppedReferences`), passed through
  `RecordedChange.auditMetadata` by `ChangeRecorder`. Ordinary requests: `metadata` null.
- `clockSkewSeconds = round((deviceTime - serverTime) / 1 s)` (`clockSkewSecondsOf`); flagged when
  its magnitude exceeds `CLOCK_SKEW_FLAG_SECONDS` = 300 (`isClockSkewFlagged`). Times are recorded,
  never corrected: the server does not move `occurredAt`.
- On a create, the work log stores `submittedOffline` (header present), `clockSkewSeconds` (from
  the header), `deviceCreatedAt` (body field: the phone's clock when the worker saved) and
  `declaredAttachmentClientIds` (body `attachmentClientIds`). `createdAt` is the server receive
  time (no separate `receivedAt` column: it would always equal `createdAt`). The work-log response
  adds `version`, `submittedOffline`, `deviceCreatedAt`, `clockSkewSeconds`, `clockSkewFlagged`,
  `declaredAttachmentClientIds`, so the supervisor view (Phase 6) can show "sent offline" and a
  clock warning.
- **Backdating limit**: organization setting `offlineMaxBackdateDays` (integer 1 to 90, default 7,
  in the existing `settings` JSON like `workLogEditWindowHours`; `offlineMaxBackdateDaysOf`; shown
  in the organization summary). On create, and on an edit that changes `occurredAt`,
  `occurredAtRangeProblem(occurredAt, serverNow, days)` must be null, else 422
  `occurred_at_out_of_range` with detail path `occurredAt`. The future margin stays
  `WORK_LOG_MAX_FUTURE_MS` = 1 hour rather than "a few minutes": a phone whose clock runs fast
  would otherwise lose every offline log; the skew is flagged instead.
- **References of an offline create**: with `x-client-sync: offline`, a `taskId`, `siteId` or
  `teamId` that is archived or no longer visible to the caller is **stored as null instead of
  refusing the log**, and the field names go into the audit metadata as `droppedReferences`. The
  log was legitimate when written; losing the link is better than losing the log, and nothing
  invisible is ever stored. The phone compares the answer with what it sent and tells the worker.
  Online creates keep the 422. An archived log type is still accepted for an offline create (the
  values are validated against its current definition; a mismatch is a 400 the worker fixes).

### 4. Server: idempotency for non-create writes

A reusable platform module `apps/api/src/platform/idempotency/` (no Operations imports), table
`IdempotencyRecord` (platform table, no foreign keys): `(organizationId, userId, key)` unique,
`method`, `path`, `requestHash` (SHA-256 of method, path and canonical JSON body), `statusCode`
and `responseBody` (null while running), `lockedUntil`, `createdAt`, `completedAt`, `expiresAt`.

- Applied by an interceptor to routes marked `@Idempotent()`: `POST /work-logs`,
  `PATCH /work-logs/:id`, `PATCH /work-logs/:id/status`, `PATCH /tasks/:id/status`. Other routes
  ignore the header. Without the header nothing changes. A header that is not a UUID: 400.
- First request: claims the key (insert, `lockedUntil` = now + `IDEMPOTENCY_LOCK_SECONDS` = 60 s),
  runs, stores the status and body of a final answer (2xx, 400, 403, 404, 409, 422) and sets
  `expiresAt` = now + `IDEMPOTENCY_RETENTION_DAYS` = 14 days. A non-final answer (401, 408, 429,
  5xx, `request_in_progress`) deletes the claim so a retry runs again.
- Repeat with the same hash: completed → the stored status and body with header
  `idempotent-replayed: true`; still running → 409 `request_in_progress`; lock expired (the
  process died) → takes the claim over and runs again (safe: the no-op rule of section 1 turns a
  re-applied change into 200). Different hash → 422 `idempotency_key_reused`.
- Expired rows are deleted by a periodic job. The stored body is only ever returned to the same
  user of the same organization.
- Creates stay idempotent by `clientId` (work logs, and now attachments), which also covers a
  resend after the key expired.

**Ordering instead of a shared transaction (as implemented).** The interceptor claims the key in
its own committed statement, then the route runs its own transaction, then the answer is stored
(or the claim released). The answer is stored only after the write returned, so a crash never
leaves a stored success without the write. A crash after the write but before the answer is
stored leaves a claim whose lock runs out; the retry takes it over and runs the route again,
which is harmless because every idempotent route is a no-op on a repeat (a create is deduplicated
by `clientId`; an edit or status change already in place answers 200 with the current record even
with a stale `expectedVersion`, and records nothing). The take-over is conditional on the lock
value seen, so of two simultaneous retries only one runs. The keys use the platform clock
(`AUTH_CLOCK`); a failure to store the answer is logged and does not change the response. Edits
and status changes also lock the row (`SELECT ... FOR UPDATE`) before reading its version, so two
concurrent changes with the same `expectedVersion` cannot both pass.

### 5. Server: photos that are part of the original submission

**Definition**: an attachment is part of a log's original submission when its `clientId` was
declared in the log's create request (`attachmentClientIds`, at most `MAX_DECLARED_ATTACHMENTS` =
20, stored in `declaredAttachmentClientIds`, never changed afterwards).

- `startAttachmentUploadSchema` takes an optional `clientId`; `Attachment.clientId` is unique per
  organization. Starting again with one's own `clientId` on the same log returns the existing
  attachment (200): with a fresh upload URL while `pending`, with `upload: null` once `ready`
  (`startedAttachmentUploadSchema`). Somebody else's clientId, or one used on another log: 409
  `conflict`.
- **Start** of an upload is allowed when the normal rule allows it (`canChangeAttachments`: the
  author inside the window and not approved, or a reviewer), **or** when all of: the caller is the
  log's author, the log is not archived, the `clientId` is in `declaredAttachmentClientIds`, and
  now is at most `DECLARED_ATTACHMENT_GRACE_DAYS` = 30 days after the log's `createdAt`. The log's
  status does not matter for declared photos (an approval before the photos arrived must not lose
  them; the reviewer is notified through the usual attachment event and can reopen).
- **Renew and complete** of a `pending` attachment the caller started are allowed for 30 days after
  the attachment's `createdAt` whatever the window (its start was already judged). This removes the
  Phase 4 limitation where an upload started inside the window could not finish after it.
- Refusals: archived log → 409 `record_archived`; author with a non-declared `clientId` (or none)
  after the window → 403 `attachment_not_declared`; declared but past the 30 days → 403
  `edit_window_closed`; otherwise the normal codes. Abuse is bounded: the list is fixed at create,
  each clientId maps to at most one attachment, and only for 30 days.
- As implemented: an undeclared photo inside the window on an approved log keeps the normal
  answer (409 `already_reviewed`); `attachment_not_declared` is used when the normal refusal is the
  closed window. The hourly cleanup that expires a pending upload older than 24 hours also clears
  its `clientId`, so a phone that comes back later with the same queued photo starts it again
  (still under the 30-day rule) instead of finding the expired one.

### 6. Server: `GET /sync/pull`

Policy `sync.pull`, all four roles (data is filtered by the caller's visibility, and the phone
app is open to every role). Query `cursor` (optional, opaque, at most 512 characters). Response
`syncPullResponseSchema`:

```ts
{
  serverTime: string;            // ISO, server clock when the pull was taken
  cursor: string;                // opaque; send it back next time
  full: boolean;                 // upserts hold everything (no cursor or unusable cursor)
  organization: OrganizationSummary; // includes workLogEditWindowHours, offlineMaxBackdateDays
  tasks:         { upserts: Task[];            ids: string[] };
  logTypes:      { upserts: LogType[];         ids: string[] };
  sites:         { upserts: Site[];            ids: string[] };
  teams:         { upserts: Team[];            ids: string[] };
  workLogs:      { upserts: WorkLog[];         ids: string[] };
  notifications: { upserts: AppNotification[]; ids: string[] };
}
```

- **Contents** (all through the existing `xxxVisibilityWhere` filters, never raw ids): tasks the
  caller is **assigned to** (the worker app's list; for a worker the same as the visible set), not
  archived, excluding done or cancelled ones unchanged for `SYNC_WINDOW_DAYS` = 30; every
  non-archived log type with its fields; visible non-archived sites and teams; the caller's **own**
  non-archived work logs created or occurred within 30 days; the caller's notifications created
  within 30 days.
- **Removals: `ids` instead of tombstones.** `ids` is always the complete current id set of each
  resource. The phone deletes every cached row not in it. That covers archived records, records
  that left the caller's visibility (reassigned task, site removed from a membership) and records
  that aged out, with no deletion log. The sets are small (hundreds of ids).
- **Delta**: `upserts` are the records of the set with `updatedAt >= cursorTime -
SYNC_CURSOR_OVERLAP_SECONDS` (60 s, the same settle idea as the outbox consumer: a transaction
  that stamped `updatedAt` before the previous pull but committed after it is not missed);
  notifications by `createdAt` or `readAt`. Log types, sites and teams are always sent whole.
- **Cursor**: base64url JSON `{ v: 1, t: serverTime, s: scopeFingerprint }`, where the fingerprint
  is a hash of the caller's memberships (roles, org-wide flag, site and team ids). An unreadable
  cursor, another version, or a different fingerprint (the scope changed: records may have become
  visible without their `updatedAt` moving) gives a full pull. Never an error.
- If an id in `ids` is neither cached nor in `upserts`, the phone pulls again without a cursor.
- As implemented: the fingerprint also covers the user, the organization, the scope's people
  (`userIds`) and the places the caller belongs to (`memberOf`, which decides a worker's sites and
  teams); a cursor whose time is after the server's clock is unusable too. The cursor time is the
  API process clock (the one `updatedAt` is stamped with); the 30-day windows use the rules' clock.

### 7. No batch sync endpoint

The queue replays the existing endpoints one write at a time, with per-record ordering on the
phone, `clientId` for creates, `Idempotency-Key` for edits and status changes, and the typed codes
above. Reasons: every write already runs through its policy, rules, `ChangeRecorder`, audit and
outbox; a batch endpoint would duplicate that dispatch and need partial-success semantics
(per-item results, which item stopped the rest), larger requests that fail as a whole on a weak
link, and its own idempotency. Per-item requests make each success final at once, so a dropped
connection loses at most the one item in flight, which idempotency makes safe to resend. Photos
cannot be batched anyway (presigned PUTs). The cost is more round trips; a worker's queue is
small (tens of items), so that is acceptable. Revisit if real queues reach hundreds.

### 8. Phone: local storage

| What                | Where                                                                                   | How long                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Read cache          | SQLite `ops-<userId>.db` (expo-sqlite, app-private): one table per resource (id, JSON)  | Replaced by each pull (30-day window); deleted at sign-out.                                                        |
| Sync meta           | Same database: cursor, `lastRefreshedAt`, `serverTime`, organization summary            | With the cache.                                                                                                    |
| Write queue         | Same database, table `queue` (`QueueItem` in `src/offline/types.ts`)                    | Until accepted (`done`, removed) or discarded by the worker. **Never deleted by age** while the user is signed in. |
| Photos waiting      | `Paths.document/offline-photos/<userId>/<localId>.jpg` (already resized, EXIF stripped) | Deleted after the upload completed; orphans swept at start.                                                        |
| Last signed-in user | SecureStore, next to the tokens (`OfflineIdentityStore`)                                | Until sign-out. Lets the app open offline with the cache.                                                          |
| New-log draft       | AsyncStorage, as in Phase 4                                                             | 14 days, as in Phase 4.                                                                                            |

- One database and one photo folder **per user id**: another user on the same phone opens their
  own; nothing of the previous user is read, shown, or sent. File names use `ops-`, never a client
  name. The data is not encrypted beyond the platform's app sandbox and device encryption (a known
  limitation; SQLCipher can be added later).
- Storage limit for offline photos: `DEFAULT_PHOTO_STORAGE_LIMIT_BYTES` = 500 MB, warning at 80%
  (`PHOTO_STORAGE_WARNING_RATIO`); at the limit new photos are refused with a clear message (the
  log itself can still be saved).
- The Phase 4 AsyncStorage upload queue (`ops.uploads.pending.<userId>`) is migrated into the new
  queue on first open (`uploadAttachment` items with the known `workLogId`) and then deleted. Its
  14-day deletion of queued photos is dropped: queued data is never deleted silently.
- **Sign-out**: with an empty queue, the user's database, photos and identity are deleted. With
  items left, the app warns and offers `syncFirst`, `keepForLater` (cache deleted, queue and
  photos kept for that user's next sign-in for `KEPT_QUEUE_MAX_DAYS` = 30 days, as the warning
  says) or `discard` (everything deleted).
- **Retention as implemented** (mobile store step, 2026-10-27): queued writes are never deleted by
  age while their user can come back, only by the worker (`discard`, "discard and sign out") or
  by acceptance. A user's data counts as "kept" (register `ops.offline.keptUsers` in AsyncStorage,
  user id and date only) when they signed out with `keepForLater`, or when **another user signed
  in** while their session had expired (ADR section 11). **Decision (2026-10-27, review):** the
  start-up sweep deletes a kept user's unsynced queue, database and photo folder only when that
  user **explicitly chose `keepForLater` at sign-out** (the register entry is marked
  `explicit`; the 30 days count from that sign-out, the period the warning names) and
  `KEPT_QUEUE_MAX_DAYS` have passed. A user registered only because their session expired and
  somebody else signed in was never warned, so their data is **never swept automatically**; it
  stays until they sign in again (and then sign out) or it is cleared by hand. Signing in again
  removes a user from the register. A user whose session merely expired (identity still stored,
  nobody else signed in) is never swept either. A sign-out cleanup registers the user for deletion
  before deleting, so a cleanup cut short by the app dying is finished by the next sweep. Deleting
  a user's data also removes their new-log and edit-log drafts and the sync engine's
  dropped-link notices (`ops.sync.droppedReferences.<userId>`). Unsaved form drafts (new-log
  and, since Phase 5, edit-log drafts `ops.drafts.editWorkLog.<userId>.<logId>`) otherwise keep
  the 14-day rule.
- The database layout is one key/value table per resource (`cache_tasks`, `cache_log_types`,
  `cache_sites`, `cache_teams`, `cache_work_logs`, `cache_notifications`) plus `meta` and `queue`,
  versioned with `PRAGMA user_version` (append-only migrations in `sqliteDatabase.ts`).

### 9. Phone: queue model

- Kinds: `createWorkLog`, `updateWorkLog`, `changeWorkLogStatus`, `changeTaskStatus`,
  `uploadAttachment`. A log is identified by its `clientId` (`recordKey` `workLog:<clientId>`), so
  edits and photos of a log not yet on the server can be queued; a task by `task:<id>`.
- States: `pending` → `sending` → `done` (removed), or `failed_retryable` (retried automatically at
  `nextAttemptAt`), or `failed_permanent` (kept until the worker retries, copies, resubmits as new,
  or discards). A `sending` item found at start is set back to `pending` (crash mid-send; the
  `clientId` / `Idempotency-Key` makes the resend safe).
- **Ordering**: items of one record are sent strictly in enqueue order, one at a time; a record's
  later items wait while an earlier one is not `done` (a permanent failure blocks its record until
  the worker acts). Different records do not wait for each other. A record's photos follow its
  create.
- **Coalescing**: an edit of a log whose create has not been sent rewrites the queued create
  (same `clientId`); consecutive unsent edits of one log are merged. After a success, the next
  queued item of the same record gets the returned `version` as its `expectedVersion`
  (`rebaseVersion`): the worker's own chain never conflicts with itself.
- `expectedVersion` of an edit or status change is the cached `version` when the worker made it.
- **Backoff**: exponential with full jitter, base 2 s, doubling, cap 15 minutes, no attempt limit
  for retryable failures (they keep trying at the cap; the list shows the reason). A manual retry
  or a reconnect resets the wait. 401 → refresh once (transport); refresh refused → `needsSignIn`.
- Each queued write sends `offlineSyncHeaders({ idempotencyKey, deviceTime: now })`.
- Results update the cache at once (the returned record), then a pull refreshes the rest.

### 10. Conflict rules (server is the source of truth)

| Situation while the worker was offline                               | Server answer                                                   | Phone                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| New log                                                              | Accepted (201, or 200 on resend) if the worker may create logs  | Synced. Unusable task/site/team link dropped and reported (section 3).         |
| New log older than `offlineMaxBackdateDays` (or > 1 h in the future) | 422 `occurred_at_out_of_range`                                  | Failed item; worker can change the date and resubmit as new, copy, or discard. |
| Edit of a log a supervisor approved                                  | 409 `already_reviewed`                                          | Failed item, worker's version visible; resubmit as new log or discard.         |
| Edit of a log a supervisor rejected, or that changed elsewhere       | 409 `version_conflict`                                          | Same; the pull shows the server version (with the rejection reason).           |
| Edit after the edit window                                           | 403 `edit_window_closed`                                        | Same.                                                                          |
| Photos of a log created offline, arriving late                       | Accepted if declared, by the author, within 30 days (section 5) | Synced.                                                                        |
| A new photo added to an old log after its window                     | 403 `attachment_not_declared`                                   | Failed item; discard (or attach to a new log).                                 |
| Task status, task reassigned away from the worker                    | 404 `not_found`                                                 | "No longer assigned to you"; the pull removes the task.                        |
| Task status, task cancelled                                          | 409 `task_cancelled`                                            | Supervisor's change wins; message; item can be discarded.                      |
| Task status, supervisor changed status meanwhile                     | 409 `version_conflict` (200 if it already has the same status)  | Supervisor's change wins; the pull shows the current status.                   |
| Task or log archived                                                 | 409 `record_archived`                                           | Message; discard.                                                              |

The phone maps every code to an i18n message. Nothing is removed from the queue without the
worker's action, except `done`.

### 11. Sessions offline

- Expired access token: the transport refreshes once; queued data is untouched either way.
- Refresh token expired or refused (400/401): the session ends, the engine reports `needsSignIn`,
  the queue is kept. The sign-in screen says that N items wait. The same user signs in → their
  database opens and the queue resumes. A different user → their own database; the previous
  user's queue is never sent and stays under the 30-day kept-queue rule.
- A refresh that fails for lack of network keeps the session (existing behaviour); the app opens
  offline with the stored identity and the cache.

### 12. Background sync

`expo-background-task` registers a task that runs one `syncNow('background')` when the OS allows
(Android WorkManager, iOS BGTaskScheduler; minimum interval 15 minutes, best effort, not in Expo
Go). Foreground sync never depends on it.

### 13. Testing without a phone: Android emulator

The AVD `hz_pixel` exists on this PC (Android Studio). Outline (the exact steps and the offline
test are in README section 6):

1. Start PostgreSQL and MinIO (`pnpm db:up`) and the API (`pnpm --filter @ops/api dev`);
   `API_HOST=127.0.0.1` can stay.
2. Start the emulator (`emulator -avd hz_pixel`), then
   `adb reverse tcp:3001 tcp:3001`, `adb reverse tcp:8081 tcp:8081`, `adb reverse tcp:9000 tcp:9000`
   so the emulator's `localhost` reaches the API, Metro and MinIO. Keep `EXPO_PUBLIC_API_URL` and
   `STORAGE_PUBLIC_ENDPOINT` on `localhost`. (Alternative: `10.0.2.2` is the host from inside the
   emulator, but then `STORAGE_PUBLIC_ENDPOINT` and `MINIO_BIND_HOST` must change; `adb reverse`
   avoids that.)
3. `pnpm --filter @ops/mobile android` (Expo Go; expo-sqlite and netinfo work there) or a
   development build (`dev:client`), which is needed for the background task and push.
4. Toggle airplane mode in the emulator (or `adb shell cmd connectivity airplane-mode enable`) to
   go offline. `adb reverse` survives airplane mode on recent emulators only partly: after
   re-enabling the network run the three `adb reverse` commands again if requests fail.

## Reasons

- Per-request replay of existing endpoints keeps one code path for online and offline writes, so
  policies, audit and outbox cannot drift.
- `ids` per resource makes removal correct by construction, including records leaving the scope,
  which a tombstone log would have to compute per user.
- Version numbers give exact conflict detection; `updatedAt` comparisons depend on clock precision
  and serialisation.
- The declared-clientId rule fixes late photos without reopening logs to arbitrary additions.
- Per-user databases make the user-switch rule a property of the file layout instead of a filter
  that must never be forgotten.

## Tradeoffs

- More round trips than a batch endpoint.
- Full id sets cost bandwidth proportional to the window (small for one worker).
- Two idempotency mechanisms (`clientId` for creates, `Idempotency-Key` for the rest).
- Dropping unusable references on offline creates changes the worker's data; it is reported and
  audited, and is preferred to losing the log.
- The local database is not encrypted beyond the OS sandbox.
- Approved logs can still receive declared photos for 30 days.
- A rare case is refused although it already took effect: an edit whose answer was lost, resent
  after its idempotency key expired (14 days) or without it, after the log was approved
  meanwhile, gets 409 `already_reviewed` (the approval check comes before the no-op rule), so
  the phone shows a refusal for a change the server holds; the worker discards it.

## Alternatives considered

- **Batch sync endpoint**: rejected (section 7).
- **`updatedAt` instead of a version**: rejected; millisecond timestamps and server clock issues
  make equality checks fragile, and a counter is clearer to clients.
- **Tombstone table for deletions**: rejected; archives are rows with `archivedAt`, but leaving a
  scope is not a row change, so `ids` is needed anyway.
- **One shared database with a `userId` column**: rejected; one forgotten filter leaks another
  user's GPS, photos and notes.
- **WatermelonDB or another sync framework**: rejected; needs native modules outside Expo Go and
  its own server protocol.
- **AsyncStorage for the queue**: rejected; no transactions, whole-value rewrites, and size
  limits on Android.
- **Correcting `occurredAt` by the measured clock skew**: rejected; the skew at send time does not
  prove the skew at capture time. Recorded and flagged instead.

## Consequences

- Every service that changes a task or work log must raise `version`; tests must cover it.
- New policy `sync.pull` in `policies.ts`, the matrix in ARCHITECTURE.md and the matrix suite.
- Existing integration tests that expect 403 for an approved log or a cancelled task, 400 for a
  future `occurredAt`, or `conflict` for an archived record must move to the new codes.
- AGENTS.md "Gotchas" must change: the photo upload queue is no longer deleted after 14 days;
  the offline database rules; the new headers.
- The mobile app needs i18n messages for every new code and the sync status UI.
- Revisit encryption of the local database and the 30-day kept-queue period with the owner.

## Test plan

- **Shared** (Vitest): new codes and statuses, header helpers, clock skew, backdating helper,
  body schemas (`expectedVersion`, `attachmentClientIds`, attachment `clientId`), pull response.
- **API unit**: rules for declared photos and the new codes (allowed and denied cases); cursor
  encoding and the scope fingerprint; request hash canonicalisation.
- **API integration**: versions raised by every change; `version_conflict` and the no-op rule;
  every code in the table above; idempotent replay, key reuse 422, in-progress 409, lock
  take-over, non-final answers not stored; offline create with `submittedOffline`,
  `clockSkewSeconds`, dropped references and audit metadata; late declared photos accepted,
  undeclared refused, 30-day cap; `occurredAt` limit from the setting; `GET /sync/pull` full and
  delta, removal through `ids` (archive, reassignment, scope change), visibility per role,
  overlap.
- **Mobile** (Jest, fakes for SQLite, network, clock and API): no duplicates under retries,
  crashes mid-send and double taps; nothing lost across restarts; per-record ordering and
  blocking; coalescing and version rebasing; every conflict code mapped; token expiry offline →
  `needsSignIn` → resume; user switch never sends the other user's queue; sign-out choices; photo
  storage limit; backoff with jitter and cap.
- **Manual**: the emulator steps above, then the owner's phone test.
