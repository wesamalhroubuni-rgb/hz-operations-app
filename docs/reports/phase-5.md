# Phase 5 report: offline mode and sync

Date: 2026-10-27. Specification: [docs/prompts/phase-5.md](../prompts/phase-5.md). Decision record:
[ADR-0008](../decisions/0008-offline-storage-sync-and-conflicts.md) (it holds the business
objective, expected behaviour, components, data, integrations, failure cases, test plan, and the
sequence diagram).

## 1. What changed

- **Server (`apps/api`)**
  - `GET /sync/pull` (policy `sync.pull`, every role): one call returns the caller's tasks, log
    types, sites, teams, own work logs of the last 30 days, and notifications. Each resource has
    `upserts` and the full current `ids` set, so the phone removes anything archived or no longer
    visible. The cursor is the server time with a 60-second overlap, bound to a fingerprint of the
    caller's scope; a scope change gives a full pull.
  - Optimistic concurrency: `version` on `Task` and `WorkLog`, raised on every update (with a
    row lock). Edits and status changes accept `expectedVersion`.
  - A reusable platform module `src/platform/idempotency/`: queued writes carry an
    `Idempotency-Key`; a repeat gets the stored answer (`idempotent-replayed` header).
  - Typed error codes the phone maps to messages: `version_conflict`, `edit_window_closed`,
    `already_reviewed`, `record_archived`, `task_not_assigned`, `task_cancelled`,
    `occurred_at_out_of_range`,
    `attachment_not_declared`, `idempotency_key_reused`, `request_in_progress`.
  - Offline work logs: the create declares its photos (`attachmentClientIds`, at most 20). Only
    those photos may be uploaded after the edit window, only by the author, within 30 days.
    `occurredAt` may be up to `offlineMaxBackdateDays` in the past (organization setting, default
    7, at most 90) and at most 1 hour in the future. Device time and clock skew are recorded and a
    skew over 300 seconds is flagged.
  - Audit: writes sent by the offline queue (`x-client-sync: offline`, `x-device-time`) get
    `AuditEvent.metadata` with `via: offline_sync`, device time, server time, skew, and any task,
    site, or team link dropped because the worker can no longer see it.
  - Migration `20261027090000_phase5_offline_sync`.
- **Shared (`@ops/shared`)**: the sync schemas and endpoint, the offline header helpers, the new
  error codes with statuses and a retryable set, `expectedVersion` on edit and status bodies,
  per-request headers in the transport.
- **Mobile (`apps/mobile`)**
  - A local SQLite database per signed-in user (`ops-<userId>.db`) with the read cache, the sync
    cursor, and a durable write queue. Every write goes through the repositories into the queue,
    online or offline; screens read the cache with the queue applied on top.
  - Photos are stored, already resized, in the app's private folder until uploaded, then deleted.
    Limit 500 MB with a warning at 80 %.
  - The sync engine: runs on reconnect, foreground, "Sync now", a timer, and (best effort) a
    background task. One run at a time, per-record order, exponential backoff with jitter, then a
    pull.
  - The sync UI: indicator, offline banner with "last refreshed", a Sync screen with pending and
    refused items (reason, retry, view, copy, send as a new log, discard), per-log sync state, a
    sign-out dialog when changes are waiting, a "sign in again" prompt when the session expired.
  - The app opens signed in from the stored session when the server is unreachable. Another user
    on the same phone gets their own database; the previous user's data is never read or sent.
- **Docs**: ADR-0008, ARCHITECTURE.md, ROADMAP.md, README.md (Android emulator steps), AGENTS.md,
  MEMORY.md, folder memory files.

## 2. Why

Field workers often have weak or no signal. They must be able to work fully offline, and every
change must reach the server once, safely, under the same permissions as online writes.

## 3. Files

The main files are listed above; `git show --stat` on the Phase 5 commit has the full list.

## 4. Architectural decisions (ADR-0008)

- SQLite (`expo-sqlite`), one database file per user. Network state from NetInfo, background sync
  through `expo-background-task`.
- Server is the source of truth; offline actions are requests validated at sync time. New offline
  logs are accepted; edits and status changes are refused with a typed code when the record moved
  on (version, review, cancellation, window). A supervisor's change wins.
- No batch endpoint: the existing write endpoints are reused, with `clientId` and
  `Idempotency-Key` for exact-once behaviour and ordering kept on the phone.
- Idempotency is not in the business transaction: claim, write, then store the answer. A crash in
  between is safe because each idempotent route does nothing on a repeat.
- Judgment calls taken (recommended options):
  - an unusable task, site, or team on an offline log is stored as empty and audited, rather than
    refusing the log;
  - a worker's task they can no longer see answers 404;
  - the future margin for `occurredAt` is 1 hour;
  - a queue kept for a user is deleted automatically only when that user explicitly chose "keep
    for later" at sign-out and 30 days passed.

## 5. Tests performed

- `pnpm build`, `lint`, `typecheck`, `test`, `test:integration`, `format:check` pass; `npx expo
install --check` is clean.
- Unit tests: shared 689, API 513, web 46, mobile 305 (including a guard so an item already being
  sent cannot be discarded). Integration tests: 1,416 in 19 suites
  (`offline-sync.int-spec.ts` has 62), against PostgreSQL and MinIO.
- Covered: no duplicates under retries, concurrent repeats, crashes and double taps; nothing lost
  across restarts; per-record order; every conflict rule; late offline logs and their declared
  photos; refusal of undeclared photos on old logs; the `occurredAt` limits; token expiry
  offline; user switch on one phone; sign-out with waiting changes; the photo storage limit; audit
  marked as offline sync; pull scope and pruning. A full offline journey test wires the real
  queue, store, repositories and engine against a fake server.
- Independent review: "pass with fixes". Fixed: the engine could send a stale copy of a queued
  item (an edit made during another upload could be lost); the local-to-server id link could be
  lost when the cache was cleared; a photo file deleted before its upload was recorded; partial
  photo saves; automatic deletion of a queue its owner never chose to keep; drafts left after
  sign-out; background task not unregistered; Expo patch drift. Documented: an edit resent after
  its log was approved shows as refused although it took effect (rare).

## 6. Limitations and next steps

- **Nothing has run on a phone or the emulator yet.** SQLite, the file system, NetInfo and the
  background task are covered only by test fakes.
- **The owner must run `pnpm db:reset`** before using the app: the development database holds a
  migration from the lost Phase 5 work.
- Older logs (beyond 30 days) and photos already on the server need a connection.
- Background sync is best effort and needs a development build; it does nothing before a session
  is open.
- Phase 6 adds the web screens to review the synced logs; until then use Swagger (`/docs`).

## Manual test (Android emulator, after `pnpm db:reset`)

Full steps for starting the emulator are in README.md ("Test offline mode in the Android
emulator"). Demo identifiers are in README section 4.

1. `pnpm db:up`, `pnpm dev` (or the API, then `pnpm --filter @ops/mobile dev` in its own
   terminal). Start the emulator `hz_pixel`; run `adb reverse tcp:3001 tcp:3001`,
   `adb reverse tcp:8081 tcp:8081`, `adb reverse tcp:9000 tcp:9000`; press `a` in Expo.
2. Sign in as `deniz` (worker). Open Tasks and Logs once so the phone has the data. The indicator
   shows "synced".
3. Turn on airplane mode in the emulator. The banner shows offline and the last refreshed time.
   `adb reverse` does not use the emulator's network, so the API may still be reachable; to be
   certain, also stop the API while offline (README section 6).
4. Create two work logs, each with a photo (camera or gallery), location, and site North Depot
   (so `selin` can see them). Change the status of
   one assigned task. The indicator shows "3 waiting" (or more, counting photos); the logs show
   "waiting".
5. Close the app completely (swipe it away) and open it again, still offline. You are still
   signed in and the items are still waiting.
6. Start the API again if you stopped it and turn airplane mode off. Within seconds the indicator goes to "syncing", then "synced". The logs
   show as sent; open one to see its photo.
7. As `selin` (supervisor), check with Swagger (`http://localhost:3001/docs`, sign in as
   `mobile` per README section 4) that the two logs and the task status arrived once each.
8. Conflict: as `deniz`, open a log of the last hours and go offline. Edit its text. Meanwhile, as
   `selin`, approve that log (`PATCH /work-logs/:id/status`). Go back online on the emulator. The
   edit is refused: the Sync screen shows "This log was approved meanwhile, so it can no longer be
   changed", with the worker's text kept. Choose "Send as a new log", "Copy", or "Discard".
9. Sign out while an item is waiting: the dialog offers "Sync first", "Keep them and sign out",
   "Discard and sign out", "Cancel".
