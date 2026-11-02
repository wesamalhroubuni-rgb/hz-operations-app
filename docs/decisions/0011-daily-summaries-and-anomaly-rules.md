# ADR-0011: Daily summaries and anomaly rules

- **Status**: Accepted
- **Date**: 2026-10-30
- **Phase**: 7

## Context

Phase 7 (`docs/prompts/phase-7.md`) asks for an automatic daily summary for each supervisor and
manager of their scope (what got done, what is late or blocked, unusual items), shown on the
dashboard Overview with its history and sent as a notification, plus rule-based, explainable
anomaly flags. Numbers must come from code, not the model; a summary must contain only what its
recipient may see; nothing is done automatically. The AI layer itself (providers, runner,
limits, tracing, prompts, data handling) is ADR-0010.

## Decision

### 1. Schedule

- A scheduler in the operations layer (`src/operations/ai/summaries/`) wakes every
  `AI_SUMMARY_POLL_INTERVAL_MS` (default 60 s) when `AI_SUMMARY_SCHEDULER_ENABLED=true` (the
  integration tests leave it off and call it directly). A `setTimeout` chain: runs never overlap.
- For each active organization with `settings.ai.dailySummaryEnabled`, when the organization's
  local time (`settings.timeZone`) has passed `settings.ai.summaryTime` (default `18:00`) on day
  D, it generates the summaries of day D that do not exist yet. Catch-up: a missed run (API down
  at 18:00) is made at the next wake-up the same local day; days already past are not generated
  automatically (an admin can use `POST /ai/summaries/generate` for up to 7 days back). The
  route's default day is the last due day (today after the summary time, else yesterday); today
  before the summary time is refused (422), so an early run cannot pre-empt the scheduled one
  with a partial day.
- A failed pass of an (organization, day) is retried at the first wake-up 15 minutes later at
  the earliest (in memory per process), not at every wake-up.
- **Idempotent per (recipient, day)**: unique `(organizationId, recipientId, day)`. Several API
  processes may race; the unique key decides, the loser skips.
- **Recipients**: active users with an active membership in one of
  `settings.ai.summaryRecipientRoles` (default supervisor and manager; admin optional; never a
  worker). Resolved when the run starts.

### 2. Scope

- Anomaly flags of day D are computed once per organization (system context, all data), stored
  with their subject ids (`AnomalyFlag`), idempotent by `fingerprint` (kind + subjects + day).
- Each recipient's facts are computed under `AccessService.runAsUser(organizationId,
recipientId, ...)` (ADR-0010 section 8): the recipient's real, freshly resolved scope, read
  only, through the same query builders and visibility filters as the dashboard overview
  (`workLogWhere`, `taskWhere`, the `xxxVisibilityWhere` filters). A user who lost access is
  refused (401) and gets no summary.
- A recipient sees a flag only when they can see **every** subject set on it (site, team, user,
  task, work log, log type); `anomalyFlagVisibilityWhere(context)` in the access layer is the one
  definition, used by the summary and by `GET /ai/anomalies`.
- The stored summary keeps a snapshot of the recipient's scope (`dailySummaryScopeSchema`) so a
  later reader knows what it covered. `GET /ai/summaries` returns only the caller's own summaries;
  an admin cannot read another person's summary (it was computed for that person's scope).

### 3. Facts in code, narrative by the model

- `stats` (`dailySummaryStatsSchema`): logs of the day by status and AI-assisted, reviews made,
  the review queue, open / overdue (due before the end of the day, or before the generation time
  while the day is still running, the same moment the anomaly rules use) / blocked / completed /
  created tasks, active and idle
  workers, per site and per team, anomaly counts by kind. All computed in code.
- The model receives only those facts (ADR-0010 section 3: names of sites and teams, completed
  task titles, people as `P1`..., no free text of logs) and the recipient's language, and writes
  a short plain-text narrative (at most 1,200 characters, prompt
  `daily-summary-narrative.v1.md`).
- **Number rule**: every number written in digits in the narrative must be one of the numbers in
  the facts (counts, the day's date parts, anomaly parameters as given). The narrative is
  checked with the runner's `validate`; a stray number is invalid output (one retry with the
  reason, then the template). Numbers written as words cannot be checked; the prompt asks for
  digits, and the template is the fallback in every doubt.
- People: the narrative may name people only as `P1`..., which must be references given in the
  facts; the code replaces them with display names after validation. An unknown reference is
  invalid output.
- **Template fallback**: a deterministic narrative built from `stats` (English catalogue, other
  languages fall back per key, like notifications), used when the feature is on but the AI is
  unavailable, over its limit, refusing or invalid twice. `narrativeSource` says which one was
  used. A summary is therefore always produced when the feature is on.

### 4. Anomaly rules v1

Constants in `ANOMALY_THRESHOLDS` (`@ops/shared`); suggestions only, never an action.

| Kind                  | Rule                                                                                                                                                                                                                                                                           | Severity                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| `no_activity_site`    | A non-archived site that is active (an open task there, or a log there in the last 14 days) has no log on day D.                                                                                                                                                               | `medium`; `high` with an overdue open task there |
| `slow_task`           | An open task (todo, in progress, blocked) older than 3 x the median duration (createdAt to completedAt) of tasks completed in the last 90 days in its group: same site and same dominant log type of their logs; site only when that sample has fewer than 5; no flag below 5. | `medium` over 3x; `high` over 6x                 |
| `repeated_rejections` | A worker with at least 3 rejections of their logs in the last 7 days (counted from the audit's `work_log.status_changed` to `rejected`, so a later resubmission does not hide it).                                                                                             | `medium`; `high` at 5 or more                    |
| `far_location`        | A log of day D with a location more than 2 km from its site's reference point: the site's own coordinates, else the median of the site's located logs of the last 90 days (at least 5; no flag below).                                                                         | `low`; `medium` over 10 km                       |

Each flag stores the numbers behind it (`params`, typed per kind); the dashboard and the
narrative render the reason from them, in the reader's language ("Harbour Project: no log today;
3 open tasks, last log 2 days ago").

### 5. Delivery and display

- Writing a summary is one transaction: the `DailySummary` row and `ChangeRecorder.record` (entity
  `daily_summary`, verb `created`; payload ids, day, narrative source, counts, no narrative). An
  outbox handler registered by the summaries module on `daily_summary.created` calls
  `NotificationService.notify` for the recipient: type `ai.daily_summary`, data
  `{ summaryId, day }`, in-app title and body rendered in the recipient's locale, **generic push
  text** ("Your daily summary is ready"), `sourceEventId` = the event id (idempotent). In-app and
  Expo push channels as for every notification; other channels later through the same interface.
- The web Overview shows the latest own summary (narrative, the key numbers from `stats`, its
  flags with reasons) with a link to the history (`GET /ai/summaries`, paginated) and an
  anomaly panel (`GET /ai/anomalies` for a day range). The narrative is rendered as plain text
  and labelled as AI-written when `narrativeSource` is `ai`.
- Admin settings page: the `settings.ai` switches, summary time, recipient roles, limits; the
  usage page reads `GET /ai/usage`.

## Reasons

- Facts in code and words from the model give a readable summary whose numbers are always right,
  and a summary even when the AI is off.
- Computing each recipient's facts under their own resolved scope, through the dashboard's
  filters, makes "a summary for selin contains only selin's scope" the same guarantee as her
  dashboard, tested the same way.
- Simple rules with stored numbers are explainable and testable; a human decides.

## Tradeoffs

- The number check cannot catch numbers written as words or wrong but present numbers (a count
  attributed to the wrong site); the facts are shown next to the narrative so a reader can check.
- Flags are computed once a day at summary time, not live; the anomaly panel shows the flags of
  past runs. Live flags are a later improvement.
- Thresholds are constants in v1, not settings.
- Anomaly parameters (open and overdue task counts per site, rejections per worker) are counted
  over the organization's data when the flag is computed (system context), so a reader who sees
  every subject of a flag may see a count that includes records outside their own scope (for
  example an open task at their site assigned to a team they cannot see). Accepted for v1;
  recounting the parameters per reader is a later improvement.
- One model call per recipient per day; a large organization with many supervisors spends more,
  bounded by the daily limits (the template takes over).

## Alternatives considered

- **The model computes the statistics from raw records**: numbers could be wrong and raw records
  would leave the scope rules to the model. Rejected.
- **One summary per site or team shared by its readers**: fewer calls, but scopes overlap
  arbitrarily (sites, teams, people, unions), so a shared summary could show one reader another's
  data. Rejected.
- **Statistical anomaly detection (z-scores, models)**: less explainable, needs more data than a
  small organization has. Later, if the rules prove too coarse.

## Consequences

- Policies `ai_summary.read`, `ai_summary.generate`, `ai_anomaly.read`; routes
  `GET /ai/summaries`, `GET /ai/summaries/:id`, `POST /ai/summaries/generate`,
  `GET /ai/anomalies` (contracts in `packages/shared/src/domain/ai-summaries.ts`).
- Entity types `daily_summary` and `anomaly_flag` in `ChangeRecorder`; the notification type
  `ai.daily_summary`.
- Tests must show a supervisor's summary never contains another scope's data (counts, names,
  flags), including after a membership change, and that narrative numbers equal the stats.
