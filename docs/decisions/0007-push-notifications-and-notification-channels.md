# ADR-0007: Push notifications, the notification-channel interface, and the outbox consumer

- **Status**: Accepted
- **Date**: 2026-10-17
- **Phase**: 4 (Mobile worker app)

## Context

The owner's Phase 4 prompt (`docs/prompts/phase-4.md`) asked for an in-app notification list and
push notifications for "a task was assigned to me" and "my log was approved or rejected", behind a
notification-channel interface that is a reusable Kaneri platform component (Phase 7 will send AI
alerts through it), using Expo push, triggered from outbox events, with device tokens stored per
user and session and removed on sign-out and when Expo reports them invalid. It also warned that
remote push may not work in Expo Go and asked for a development build if needed. The in-app list
must work regardless.

Until Phase 4 the outbox had no consumer. Its sequence numbers are assigned at insert, not at
commit, so a reader that only follows a cursor can skip an event from a transaction that commits
late (noted in Phase 2 and in the Phase 7 roadmap).

## Decision

### Channels

`src/platform/notifications/` (no Operations imports):

- **The in-app row is the source of truth.** `NotificationService.notify` writes `Notification`
  rows (platform table, no foreign keys to business tables) for the active users of the
  organization among the requested recipients, then hands the rows **it actually inserted** to
  every `NotificationChannel` registered under `NOTIFICATION_CHANNELS`, **after the commit**, in
  the background. A channel never throws into its caller and never blocks or rolls back a business
  transaction. `notifyInTransaction` writes inside a caller's transaction and delivers nothing; the
  caller calls `deliver` after the commit.
- **Idempotent per source event**: the unique key `(sourceEventId, recipientId, type)` makes a
  re-processed event write and push nothing new.
- **Generic push text.** A notification can carry `push: { title, body }`, used by out-of-app
  channels instead of the full text. The Operations catalogue sends "New task assigned", "Work log
  approved", "Work log rejected" with "Open the app to see it" (or "for the reason"), so no task
  title or rejection note reaches a lock screen (finding L1). The in-app row keeps the full text.
- **Expo push channel** (`expo-push.channel.ts`, `expo-push-client.ts`): one message per live
  device token of the recipient, with only ids in `data` (`notificationId`, `type`, `taskId` or
  `workLogId`). The client is plain `fetch` to Expo (10 s timeout per attempt, 2 retries on 429,
  5xx, or network failure, honouring `Retry-After`); tokens are masked to their last six characters
  in every log line. Tickets are read at once; accepted tickets are kept **in memory** and their
  receipts fetched every 5 minutes for tickets at least 15 minutes old; tickets with no receipt
  after 24 hours are dropped. `DeviceNotRegistered` in a ticket or a receipt removes the token.
  Off unless `PUSH_ENABLED=true`; `EXPO_ACCESS_TOKEN` is optional (only for Expo's "enhanced push
  security").
- Notification rows are derived data and are **not** audited or written to the outbox.

Routes (all `@Authenticated()`, self-service, a user sees only their own):
`GET /notifications` (`unread` filter, list plus `unreadCount`), `POST /notifications/:id/read`,
`POST /notifications/read-all`, `POST /notifications/push-tokens` `{ token, platform }`,
`DELETE /notifications/push-tokens/:token`.

### Push token lifecycle (`push-tokens.service.ts`)

- A token is bound to the caller **and the session** of the request; a session holds one token
  (registering another replaces it). Registering a token known for another session or user removes
  it there and binds it here (**rebinding**, accepted and audited: a phone that changed hands or
  signed in again).
- Unregistering is for one's own token only; anything else is 404.
- **Every way a session ends** (logout, logout everywhere, ending one session, refresh-token reuse,
  password change or reset, archiving, membership removal) goes through `SessionService`, which
  calls a hook inside the same transaction: the tokens go with the same commit.
- At delivery, tokens of a revoked or expired session are removed (expiry has no event).
- Audit actions `push_token.registered` and `push_token.removed` (reasons `unregistered`,
  `session_ended`, `rebound`, `replaced`, `device_not_registered`) store the row id, platform,
  session, and a six-character suffix, never the token. The request log replaces the token in
  `DELETE /notifications/push-tokens/<token>` with `:token` (case-insensitive).
- The app registers after sign-in and on every cold start with a live session, registers again
  when it returns to the foreground after 24 hours in the background (finding L2), and unregisters
  before signing out.

### Outbox consumer (`src/platform/outbox/outbox-consumer.ts`, `outbox-consumer-state.ts`)

- A named consumer (`platform.notifications`) with a cursor row in `OutboxConsumerCursor`. Hosts
  register handlers by event type or prefix; **the platform knows no event names**. The Operations
  rules (`src/operations/notifications/`) register for `task.created`, `task.assignees_changed`,
  and `work_log.status_changed`.
- **Late commits**: every event above the cursor is handled as soon as it is seen, but the cursor
  only passes an event once it was first seen **60 seconds** ago (transactions time out after 5 s).
  The window above the cursor is re-read each poll; events already handled are skipped.
- **Idempotency** comes from the unique notification key; handlers must not rely on strict order.
- **Retries**: a failing event is retried with exponential backoff (2 s doubling, at most 60 s),
  holds the cursor meanwhile, and is given up on (logged as an error) after 5 attempts so one bad
  event cannot stall the consumer.
- **Throughput**: 200 events per read, at most 2000 per pass; after a pass that hit its limit, the
  next read continues after the highest sequence seen, and only a read that started at the cursor
  may move it. It runs straight on only while passes make progress: a burst within the settle
  window does not cause a hot loop (finding L3).
- **Multi-instance safe**: each instance handles every event; the stored cursor only moves forward.
- **First start** with no cursor begins after the newest existing event: history is not replayed
  into notifications.
- Polls every `OUTBOX_POLL_INTERVAL_MS` (default 2000) when `OUTBOX_CONSUMER_ENABLED=true`. Tests
  leave it off and call `processPending()`.

### Event rules (`src/operations/notifications/`)

| Event                                   | Recipients                             | Type                |
| --------------------------------------- | -------------------------------------- | ------------------- |
| `task.created`                          | the assignees, minus the actor         | `task.assigned`     |
| `task.assignees_changed`                | the added assignees, minus the actor   | `task.assigned`     |
| `work_log.status_changed` to `approved` | the author, unless the author reviewed | `work_log.approved` |
| `work_log.status_changed` to `rejected` | the author, unless the author reviewed | `work_log.rejected` |

A repeated approval (`approved` to `approved`, correcting the note) notifies nobody; a repeated
rejection notifies again, because the reason changed (finding L6). Before writing, the current
state is re-checked: the task is not archived and the recipient is still an assignee; the log is
not archived, the recipient is its author, and its status is still the announced one. Text comes
from an English catalogue (`notification-messages.ts`).

### Expo Go and the development build

- **Android Expo Go has no remote push since SDK 53**: asking for a push token throws. **iOS Expo
  Go still receives remote push** when the app has an EAS project id. Simulators get no token.
- So push on Android needs a **development build**: `expo-dev-client` is installed,
  `apps/mobile/eas.json` has a `development` profile (internal distribution, Android APK), and
  `pnpm --filter @ops/mobile dev:client` serves it. The app skips push registration in Expo Go on
  Android and without `EXPO_PUBLIC_EAS_PROJECT_ID`, and says so on the Profile screen; the in-app
  list works in every case. The owner's steps are in README section 5.

## Reasons

- **In-app row first, channels after commit**: the list is always right even when Expo, Apple, or
  Google are down, and a push can never announce something that was rolled back.
- **A channel interface** lets Phase 7 (AI alerts) and Phase 8 (email, SMS) add channels without
  touching the business code, and keeps Expo-specific code in one class.
- **Generic push text** keeps record content off lock screens and out of Expo, Apple, and Google.
- **The settle rule** closes the late-commit gap with only the application's own clock, no
  database locks, and no latency for the normal case.
- **Tokens bound to sessions** make sign-out and "sign out everywhere" stop pushes with no extra
  client call, and reuse the existing session revocation paths.

## Tradeoffs

- Push receipts are tracked in memory: a restart forgets pending receipts, so a dead token is then
  found on the next failed send instead. Durable receipts need a table (Phase 8).
- Rebinding a token to another user is accepted: whoever registers a token last receives its
  pushes. A token is a device secret that only the Expo SDK on that device produces.
- Notification text is rendered on the server in English only; the recipient's language is not
  stored (Phase 6).
- The consumer re-reads about 60 seconds of events every poll and re-handles that window after a
  restart (idempotent, so harmless).
- A retried Expo send after a network failure can, rarely, deliver a push twice.
- Push on Android needs a development build, which needs an Expo account and an EAS build (not yet
  run by anyone).

## Alternatives considered

| Alternative                                  | Why not                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| FCM and APNs directly                        | Two providers, Apple keys and Google service accounts to manage, and native setup; Expo push wraps both with one token type for an Expo app. |
| A push SDK (expo-server-sdk or a vendor SDK) | Two JSON endpoints do not justify a dependency; the in-house client is one small file, fully testable with a fake `fetch`.                   |
| A message broker (Redis streams, RabbitMQ)   | New infrastructure to run and secure; the outbox already gives transactional events, and one consumer at this scale needs no broker.         |
| Sending from the business transaction        | A slow push provider would hold the transaction, and a rollback could follow a sent push.                                                    |
| Cursor-only consumer                         | Misses late-committing events.                                                                                                               |
| Replaying history on first start             | Would push old events to every user at the first deployment.                                                                                 |
| Full text in pushes                          | Puts task titles and rejection reasons on lock screens and through third parties.                                                            |

## Consequences

- Register event handlers from Operations modules; never put an event name in `src/platform`.
- Any new push text must be generic; full text goes in the in-app row only.
- Tests run with the consumer and push off and call `processPending()`.
- Phase 6: localise notification text (store the recipient's language). Phase 7: AI alerts as
  another sender through `NotificationService` and the channels. Phase 8: durable push receipts
  (a `PushTicket` table), a shared rate limiter, and the owner's Expo account and store setup.
