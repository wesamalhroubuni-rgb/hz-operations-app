WORKING DIRECTORY: D:\Personal Projects\Huseyin\Operations_App

PHASE 5 of 8 — Offline mode and sync

## Start of session
Follow AGENTS.md: read AGENTS.md → MEMORY.md → ARCHITECTURE.md → ROADMAP.md → ADR-0002 to ADR-0007 → apps/mobile/memory.md, packages/shared/memory.md, apps/api/memory.md.

Phase 4 is complete and committed (also pushed to a private GitHub repo). **The Phase 4 phone test has NOT been done yet**: this PC is Ethernet-only and my phone can't reach it, so I postponed phone testing. Record this in MEMORY.md as an open item. Before changing anything, run build, lint, typecheck, test and `pnpm test:integration` to confirm a green start; report and fix anything that fails.

## Goal
Field workers often have weak or no signal. A worker must be able to use the app fully offline for their own work — see their tasks, create and edit logs with photos and location, change task status — and everything must sync automatically and safely when the connection returns, with nothing lost and nothing duplicated.

## Offline behavior (worker app)
- **Read offline:** cache on the phone what a worker needs: their assigned tasks, log types (with custom field definitions), their sites/teams, their recent logs, and notifications. Show when data was last refreshed.
- **Write offline:** creating a work log (with photos, location, custom fields), editing their own logs, and changing the status of their tasks all work offline and go into a local queue. Use the single repository layer built in Phase 4 so screens don't change.
- **Photos offline:** stored locally (already resized) until uploaded; removed from the phone after a successful upload and once no longer needed; enforce a local storage limit with a clear warning.
- **Sync:** automatic when connectivity returns and when the app comes to the foreground, plus a manual "Sync now". Process the queue in order per record, with retries and exponential backoff. Use background sync where the platform reasonably allows it; foreground sync must always work.
- **Idempotency:** every queued write carries its client-generated id, so a retry, a crash mid-sync or a double tap never creates duplicates. Uploads resume or restart safely.
- **Sync status UI:** a small indicator (synced / pending N / failed), a list of pending and failed items with the reason, retry, and — for items the server permanently rejects — a way to view, copy or discard them. Never silently drop a worker's data.

## Rules and conflicts (decide, implement, document in ADR-0008)
Recommended rules — follow them unless you find a serious problem, then explain and ask:
- **Server is the source of truth.** Offline actions are requests the server validates at sync time with the normal Phase 3 permissions.
- **New logs created offline are always accepted** if the worker was allowed to create them, even if they arrive days later. Allow `occurredAt` in the past up to a configurable limit per organization (default 7 days); record both `occurredAt` and the server receive time. Don't trust the phone's clock blindly: record the device time and the server time, and flag large differences.
- **Photos for a log created offline must be accepted when they sync**, even after the normal edit window (this fixes the Phase 4 limitation where an upload started inside the window couldn't complete after it closed). Define precisely what counts as "part of the original submission" so this can't be abused to add photos to old logs later.
- **Edits to existing logs:** judged by the server at sync time. If the log was approved, rejected or edited by someone else in the meantime, or the edit window has closed, the server rejects the edit with a clear reason; the phone keeps the worker's version visible as a failed item, and the worker can resubmit as a new log or discard it.
- **Task status changes:** if the task was reassigned, cancelled or changed by a supervisor while the worker was offline, the supervisor's change wins and the worker sees a clear message.
- Use version numbers or `updatedAt` checks (optimistic concurrency) on the server for edits and status changes.

## Sessions and security offline
- An expired access token must not lose queued data. If the refresh token has expired while offline, keep the queue, ask the worker to sign in again, then continue syncing.
- The queue belongs to the signed-in user. Signing out with unsynced items must warn clearly and offer "sync first". Another user signing in on the same phone must never see or send the previous user's queued data.
- Local data contains personal data (GPS, photos, notes): store it in the app's private storage, clear cached data on sign-out (after the queue is empty or the user explicitly discards it), and document what is stored and for how long.
- Every synced write still goes through the API's policies, audit log and outbox exactly like online writes. Record in the audit log that a write came from offline sync, with device time and server time.

## Backend work
- Efficient refresh for the phone: "changed since" (delta) endpoints or a sync cursor for tasks, log types, logs and notifications, scoped by the caller's permissions, including deletions/archivals so the phone can remove stale items.
- Optimistic concurrency on edits and task status changes; clear, typed error codes the phone can map to messages (e.g. edit window closed, already approved, conflict, no longer assigned).
- Optionally a batch sync endpoint if it clearly reduces failure cases; otherwise reuse the existing endpoints. Justify the choice in ADR-0008.

## Testing without my phone
I can't test on a real phone from this PC yet. Make offline behavior testable here:
- Thorough automated tests of the sync engine with simulated network loss, slow networks, crashes mid-sync, app restarts, token expiry, clock skew and server conflicts.
- If practical on this Windows PC, set up the **Android emulator** (Android Studio) so I can run the app on this PC and toggle airplane mode in the emulator to test offline for real. Document the exact steps in the README, including how the emulator reaches the API (e.g. 10.0.2.2 or `adb reverse`). If the emulator isn't practical here, say why and give me the best alternative.

## Out of scope
Web dashboard (Phase 6), AI features (Phase 7), offline mode for supervisors/managers or the web app, and real-time collaborative editing.

## Before building
Per AGENTS.md, first state: business objective, expected behavior, components affected, data required, external integrations, failure cases, test plan. Include a sequence diagram (Mermaid) of: offline log with photos → reconnect → sync → server validation → result on the phone. Write ADR-0008 (offline storage, sync and conflict rules). Then proceed without waiting for approval.

## Subagents
- Run in parallel: one subagent for the backend (delta endpoints, concurrency checks, error codes, offline-submission rules), one for the mobile local database, cache and queue, one for the sync engine and sync-status UI (after the contracts in packages/shared are agreed).
- Use the project `test-writer` subagent for: no duplicates under retries/crashes/double taps; nothing lost across restarts; ordering per record; every conflict rule above; late offline logs and their photos accepted, but no adding photos to old logs; occurredAt limit; token expiry while offline; user switch on the same phone; sign-out with pending items; local storage limit; audit records marked as offline sync.
- Then run the project `reviewer` subagent against this prompt, AGENTS.md and the Phase 3 security rules, with special attention to data loss and data leaking between users on a shared phone. Fix what it finds.
- Finally run `docs-keeper` to update MEMORY.md, ARCHITECTURE.md, ROADMAP.md (Phase 5 done-when criteria), ADRs, README and every touched folder's memory.md.

## When finished
- Run install, build, lint, typecheck, test, test:integration and format:check; apply migrations; confirm `pnpm dev` starts everything. If the permission system blocks `pnpm db:reset`, tell me to run it.
- Give me the end-of-change summary described in AGENTS.md.
- Give me an exact step-by-step offline test I can do (in the Android emulator if you set it up, otherwise the best available option): go offline, create two logs with photos and change a task status, restart the app, go online, watch them sync; then a conflict case (supervisor approves a log while the worker edits it offline) and what the worker should see.
- Do not commit; I will review and commit myself.
