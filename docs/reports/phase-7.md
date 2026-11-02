# Phase 7 report: intelligent layer v1 (smart capture, daily AI summaries)

Date: 2026-11-02 (work from 2026-10-30). Specification:
[docs/prompts/phase-7.md](../prompts/phase-7.md). Decision records:
[ADR-0010](../decisions/0010-ai-layer-architecture.md) (AI layer, providers, data handling, cost
controls, with the business objective, expected behaviour, components, data, integrations,
failure cases, and test plan) and [ADR-0011](../decisions/0011-daily-summaries-and-anomaly-rules.md)
(daily summaries and anomaly rules).

Everything below was built and tested with the deterministic **fake** AI providers. No real
provider has been called yet: section 7 lists the keys to obtain.

## 1. What changed

- **Smart capture (phone and API)**: on the phone's Home and New log screens, "Speak" (a voice
  note of up to 2 minutes), "Snap" (a photo with an optional note), and "Type a note". The API
  transcribes the voice note (OpenAI speech-to-text), asks Claude for a proposed work log (type
  of work, custom fields, text, task, site, time) that must match a schema built from the
  organization's own log types, and returns it. The phone opens the normal log form filled from
  the proposal, with the transcript, an "AI-suggested" marker, and a confidence hint per field;
  the worker changes what is wrong and saves (an ordinary `POST /work-logs` with
  `source: 'ai_assisted'` and `aiProposalId`), or discards. Nothing is saved without the worker.
  If the AI cannot make sense of it: "Couldn't understand, please fill in manually", transcript
  kept. Offline, captures wait in the Phase 5 queue and are processed when online; the form can
  always be filled by hand. Captures waiting for review count as unfinished work at sign-out.
- **Daily summaries and anomaly flags (API, web, notifications)**: at the summary time (default
  18:00 in the organization's time zone) every supervisor and manager gets a summary of **their
  own scope**: numbers computed in code (logs, reviews, open, overdue, blocked, completed tasks,
  active and idle workers, per site and team), a short narrative written by Claude from those
  numbers only (checked: every number must be one of the facts; otherwise a plain template), and
  rule-based unusual items (no activity at an active site, a task far slower than similar ones,
  repeated rejections of one worker, a log far from its site). Shown on the Overview, browsable
  under Summaries, and sent as a notification (full text in-app, generic push). Suggestions
  only; nothing acts on them. An admin can generate a past day on demand (API route).
- **Admin**: Settings has an AI section (switch each feature on or off, both off by default;
  summary time; recipients by role; daily request and cost limits below the server's ceiling);
  the AI usage page shows calls, outcomes, tokens, and estimated cost per day.
- **Platform (reusable Kaneri component)**: `apps/api/src/platform/ai/` with provider interfaces,
  the Anthropic adapter (`@anthropic-ai/sdk` pinned to 1.3.0), OpenAI speech-to-text over
  `fetch`, deterministic fakes, one runner for every AI call (limits, timeout, one retry,
  validation, tracing), the trace table `AiTrace`, the usage limiter, the price table, and the
  versioned prompt loader. It imports nothing from the Operations domain.
- **Data**: migration `20261030090000_phase7_ai` (`SmartCapture`, `DailySummary`, `AnomalyFlag`,
  `AiTrace`; `WorkLogSource.ai` renamed to `ai_assisted`). 10 new API paths (78 in all), five
  policies, three error codes (`ai_disabled` 403, `ai_limit_reached` 429, `ai_unavailable` 503).
- **Configuration**: optional `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_PROVIDER`,
  `AI_LLM_MODEL`, `AI_STT_MODEL`, `AI_ANTHROPIC_REFUSAL_FALLBACK`, `AI_REQUEST_TIMEOUT_MS`,
  `AI_DAILY_LIMIT_PER_ORG`, `AI_DAILY_COST_LIMIT_USD_PER_ORG`,
  `AI_RATE_LIMIT_PER_USER_PER_MINUTE`, `AI_SUMMARY_SCHEDULER_ENABLED`,
  `AI_SUMMARY_POLL_INTERVAL_MS` (`.env.example`, the API's validation, `turbo.json`). The mobile
  app gained `expo-audio` (~57.0.5) with a microphone permission text.

## 2. Why

Make logging faster and richer for workers (speak or snap instead of typing, in their own
language) and give supervisors and managers an end-of-day picture of their scope with the unusual
items called out, without making the product less reliable or leaking data across scopes.

## 3. Files

`git show --stat` on the Phase 7 commit has the full list. Main areas:
`apps/api/src/platform/ai/`, `apps/api/src/operations/ai/` (with `prompts/`),
`apps/api/prisma/migrations/20261030090000_phase7_ai/`, `apps/api/src/operations/access/`
(`runAsUser`, `anomaly.rules.ts`, policies), `apps/api/src/operations/work-logs/` (the confirm
path), `apps/api/scripts/copy-prompts.mjs`, `packages/shared/src/domain/ai-*.ts`,
`packages/shared/src/platform/ai.ts`, `apps/mobile/src/screens/CaptureScreen.tsx`,
`apps/mobile/src/components/SmartCapture.tsx`, `apps/mobile/src/offline/` (queue kinds, capture
and audio stores), `apps/web/src/components/ai/`, `apps/web/src/app/(dashboard)/summaries/`,
`apps/web/src/app/(dashboard)/ai-usage/`, `apps/web/src/components/settings/ai-settings-section.tsx`.

## 4. Architectural decisions (ADR-0010, ADR-0011)

- Two layers: a reusable AI platform (providers, runner, traces, limits, prompts) and the
  Operations features on top. The AI never writes a business record on its own; a log exists only
  when the worker saves it.
- Providers: **Anthropic Claude** (default `claude-opus-5-5`) for proposals, photo understanding,
  and narratives; **OpenAI `gpt-4o-transcribe`** for speech-to-text (chosen over self-hosted
  Whisper, Google Chirp 2, Deepgram, and ElevenLabs Scribe for Turkish and Arabic accuracy, no
  infrastructure, and price). Both optional; without keys the fakes run in development and
  tests, and in production the feature is "unavailable" (the app keeps working).
- Data sent is the minimum (ADR-0010 section 3): no names, e-mail addresses, phone numbers, ids,
  storage keys, or URLs; people in a summary are references the code resolves. User text,
  transcripts, task titles, and site names go only inside escaped data blocks, and the model has
  no tools: a prompt injection can at most change the proposal the worker reviews.
- Numbers in summaries come from code; each recipient's facts are computed under their own scope
  (`AccessService.runAsUser`) through the dashboard's filters; one summary per recipient and day.
- Retention: capture inputs deleted after 30 days (7 after a decision), transcripts and
  proposals cleared after 90 days, trace outputs after 90 days, trace rows after 400 days.
- Judgment calls taken in the review (recommended options): the summary generate route runs as
  the system with the admin recorded in the audit metadata; `process` and `upload-url` are not
  `@Idempotent()` (idempotent by state); the Anthropic refusal fallback is off until checked with
  a real key; a provider refusing the request itself ends the capture `failed`
  (`provider_rejected`) instead of retrying forever.

## 5. Tests performed

- `pnpm build` (prompt files present in `apps/api/dist/operations/ai/prompts/`), `typecheck`,
  `lint`, `format:check`, `test`, `test:integration` pass; `npx expo install --check` is up to
  date.
- Unit tests: API 706 (35 suites), shared 764, web 191, mobile 332 (28 suites); re-run by the
  docs-keeper on 2026-11-02. Integration tests: 1,681 in 26 suites plus 6 in `storage-minio`.
- Covered (fakes): summary scope isolation (two supervisors, scope changes, flags), invalid model
  output and the retry, fake provider end to end, prompt-injection attempts in transcripts and
  task titles, narrative numbers equal the statistics, feature switches and limits,
  offline-queued voice notes processed on reconnect, the core with AI off; every new policy in
  the permissions matrix. The test-writer's 46 new tests found no bug.
- Independent review: "pass with fixes", nothing blocking. Fixed: the generate route's default
  day and the refusal of today before the summary time; overdue counted up to the end of the
  day; unreviewed captures counted at sign-out; the refusal-fallback switch, provider 4xx as
  `provider_rejected`, and pricing of an unexpected answering model; null for nullable values in
  the fake; a 15-minute back-off per organization and day in the scheduler; the capture-to-log
  foreign key; ADR notes.

## 6. Limitations and next steps

- **Not run with real providers** (no keys): Claude's acceptance of the structured-output
  request and the photo input with SDK 1.3.0, the refusal fallback beta, OpenAI with the phone's
  m4a, the quality of proposals and narratives in Turkish, English, and Arabic.
- **Not run on a phone or in the emulator, and not used in a browser with data**, like Phases 4
  to 6. The development database needs the owner's `pnpm db:reset` first.
- Prompts, the summary template, and notification texts exist in English only (Turkish and
  Arabic fall back per key).
- Usage limits count per UTC day; the per-user rate limit is in memory per process; a model
  missing from the price table counts $0 against the cost limit.
- Anomaly parameters are counted over the whole organization (a reader may see a count including
  records outside their scope; accepted for v1); flags are computed once a day.
- No web button to generate summaries on demand (Swagger or PowerShell, below).
- Before production (Phase 8): data processing agreements with both providers, zero data
  retention where available, a re-check of the price table, a prompt review with real samples.

## 7. API keys to obtain

| Key                 | Get it at                                                                                          | Used for                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ANTHROPIC_API_KEY` | <https://console.anthropic.com>: create an account, add billing, Settings, API keys, "Create key". | Claude: proposals from transcripts, notes, photos; summaries |
| `OPENAI_API_KEY`    | <https://platform.openai.com>: create an account, add billing, API keys, "Create new secret key".  | Speech-to-text of voice notes (`gpt-4o-transcribe`)          |

Put both in the **root `.env`** (`ANTHROPIC_API_KEY=...`, `OPENAI_API_KEY=...`, keep
`AI_PROVIDER=auto`), never in a committed file or a chat, and **restart the API**. The API log at
start then says `AI providers: llm=anthropic/claude-opus-5-5 speechToText=openai/gpt-4o-transcribe`.
Set a monthly spending limit in each provider's console. Optional settings: `AI_LLM_MODEL` (a
cheaper Claude model must also be in `apps/api/src/platform/ai/ai-prices.ts`), the daily limits
`AI_DAILY_LIMIT_PER_ORG` (500) and `AI_DAILY_COST_LIMIT_USD_PER_ORG` (10),
`AI_RATE_LIMIT_PER_USER_PER_MINUTE` (6), `AI_REQUEST_TIMEOUT_MS` (30000), and
`AI_ANTHROPIC_REFUSAL_FALLBACK` (leave `false` until a real capture has worked). README section
11 has the details.

## Manual test: Phases 4 to 7 together

Sign-in identifiers are in README section 4; the development passwords are only in
`DEV_PASSWORDS` in `apps/api/src/operations/seed/demo-seed.ts`. Never write them anywhere else.
Work through the parts in order; each part says which earlier phase it checks. Note anything that
fails with the step number.

### A. Setup (once)

1. Start Docker Desktop and wait for the engine. From the repository root:
   `pnpm install`, then `pnpm db:up`.
2. **`pnpm db:reset`** (owner only; it deletes all data in the development database, applies the
   seven migrations, and seeds the demo data). It replaces the stray Phase 5 migration from the
   lost work.
3. `.env` on this PC: `POSTGRES_PORT=5433` and port 5433 in `DATABASE_URL` and
   `DATABASE_URL_TEST` are already set (port 5432 belongs to another project). Port 3000 is taken
   too, so set:

   ```dotenv
   WEB_PORT=3100
   CORS_ORIGINS=http://localhost:3100
   WEB_APP_URL=http://localhost:3100
   ```

   Leave `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` empty for now (the fakes come first; part I adds
   the real keys).

4. In two terminals: `pnpm --filter @ops/api dev` and `pnpm --filter @ops/web dev`. Open
   <http://localhost:3001/health> (`"database":"up"`). The API log shows
   `AI providers: llm=fake/fake-llm-1 speechToText=fake/fake-stt-1`.

### B. Web dashboard as aylin (admin) (Phase 6)

5. Open <http://localhost:3100>, sign in as `aylin`. Overview numbers load; click "awaiting
   approval" and check the list shows the same count.
6. Work logs: filter by site and date range, sort, page; reload, the filters stay. Open a log:
   fields, history. Approve one with a note; select several submitted logs and approve in bulk
   (your own logs cannot be selected).
7. Export the filtered list as CSV and open it in Excel (Turkish letters correct); open the
   printable report and the print preview.
8. Tasks: the board; create a task at **North Depot**, assign `deniz`, change its priority, block
   it with a reason. Keep it open (part D uses it).
9. People: invite a new user (the code shows once), issue a password reset code, view a user's
   sessions; change a membership's scope. Structure: add a team; edit a log type (add a field,
   reorder, required, choices), save: the version goes up. Audit log: filter and open an event.
10. Settings: change the time zone and back; the times change. The **API status** card shows the
    API as reachable.
11. Settings, **AI** section: both switches are off. Leave them off for now. **AI usage** opens
    and shows no calls.
12. Phone and desktop widths (narrow the window), keyboard only (Tab through a page), the map
    tiles on Map.

### C. Web as selin (supervisor) and murat (manager) (Phase 6)

13. Sign out; sign in as `selin`. Only North Depot data; change `siteId` in the URL to another
    site: empty list; open a Harbour Project log by its URL: "not found". No People, Structure,
    Audit log, Settings, or AI usage; Summaries is there (empty). Your own log cannot be approved.
14. Sign in as `murat`: the whole organization; People (read only) and Structure; no Audit log,
    Settings, or AI usage; can export and use the map.

### D. The worker app in the emulator as deniz (Phase 4)

Use the Android emulator `hz_pixel` as in README section 6 ("Start it": emulator, the three
`adb reverse` commands, `$env:ANDROID_HOME`, then `pnpm --filter @ops/mobile dev --clear` and
`a`). On a real phone, use README section 5 instead (hotspot, `API_HOST=0.0.0.0`,
`MINIO_BIND_HOST=0.0.0.0`, the PC's address, firewall) and switch back afterwards.

15. Sign in as `deniz`. Home: tasks due today and overdue first, recent logs, "New log". The
    Speak, Snap, and Type a note buttons are **not** shown (smart capture is off).
16. Tasks: open the task from step 8, "Start work", then "Mark as blocked" with a reason.
17. New log: pick a log type, fill its fields, add a photo (camera or gallery), allow location,
    set the site to **North Depot**, save. The photo uploads with progress; the log is under
    Logs. Open it and edit it.
18. Profile: name, role, organization, push status (off in Expo Go on Android), app version,
    "Powered by Kaneri.ai".

### E. Review and notifications (Phases 4 and 6)

19. In the browser as `selin`: Work logs, open `deniz`'s log from step 17: photo (signed URL),
    location on the map, custom fields. Reject it with a note.
20. In the emulator: within a few seconds the Alerts tab shows the rejection with the note (pull
    to refresh). Open the log: the rejection reason; resubmit it.
21. As `selin`, approve it. `deniz` gets the approval notification.

### F. Offline and the conflict (Phase 5)

22. As `deniz`, while online, check the sync indicator says synced. Turn on **Airplane mode** and
    stop the API (`Ctrl+C`) so nothing reaches the server.
23. Create two logs with a photo each (North Depot) and change a task's status. Each shows
    "Waiting to send"; the indicator counts them.
24. Close the app completely and reopen it from Expo Go: still signed in, the changes still
    waiting.
25. Start the API, turn Airplane mode off (run the three `adb reverse` commands again if
    requests fail). The indicator returns to synced. As `selin` in the browser: both logs with
    their photos and the task status arrived exactly once.
26. Conflict: as `deniz`, go offline and edit one of those logs; meanwhile approve it as `selin`
    in the browser. Back online: the Sync screen says "This log was approved meanwhile, so it can
    no longer be changed" and offers "Send as a new log", "Copy", and "Discard".
27. Sign-out with unsent items: go offline, create a log, Profile, "Sign out": the dialog offers
    sync first, keep for later, or discard. Choose "Sync first" after going back online.

### G. Smart capture with the fake providers (Phase 7)

28. As `aylin` in the browser: Settings, AI: switch **smart capture** on, save.
29. In the emulator as `deniz`: pull down on Home (or "Sync now"). Speak, Snap, and Type a note
    appear on Home and on the New log screen.
30. **Type a note**: type "Checked the fire extinguishers at North Depot", "Get a proposal". The
    capture is processed and the log form opens with what you typed shown; with the fake the
    proposal is empty. Fill the form by hand and save. The log appears under Logs; as `selin` in
    the browser its detail shows the source "AI-assisted, confirmed by the worker".
31. **A filled-in proposal** (fake): copy this line on the PC and paste it into Type a note in
    the emulator (the emulator shares the clipboard):

    ```text
    FAKE-LLM-JSON:{"logType":{"key":null,"customFields":{},"fieldConfidence":{}},"logTypeConfidence":null,"taskRef":null,"taskConfidence":null,"siteRef":null,"siteConfidence":null,"text":"Replaced the fuse in panel B.","textConfidence":"high","occurredAt":null}
    ```

    The form opens with the text "Replaced the fuse in panel B." marked "AI-suggested" with a
    high-confidence hint. Change the text and save.

32. **"Couldn't understand"**: Type a note with `FAKE-LLM-INVALID` in it. The capture ends
    "Couldn't understand, please fill in manually" with your text kept; fill in by hand or
    discard.
33. **Speak**: allow the microphone when asked (Expo Go shows its own text). Record a few
    seconds, stop, "Get a proposal". With the fake the transcript is "Fake transcript" and the
    form is empty. In the emulator the microphone is silent unless "Virtual microphone uses host
    audio input" is on (the emulator's "..." button, Microphone); with the fakes that does not
    matter.
34. **Snap**: take a photo, add a note, "Get a proposal"; the form opens (empty proposal with the
    fake). Discard this capture: it disappears from Home.
35. **Offline capture**: Airplane mode on and the API stopped. Type a note: it shows "Waiting to
    be processed" on Home; you can still fill a log by hand. Start the API, Airplane mode off:
    the capture is processed and can be reviewed.
36. **Sign-out with an unreviewed capture**: leave one capture unreviewed and sign out: the
    dialog counts it as unfinished work. Cancel.
37. **Switch off**: as `aylin`, switch smart capture off and save. In the emulator, after a sync,
    the buttons disappear; a capture already waiting for review is still listed. Switch it back
    on.
38. **Limit**: as `aylin`, set the daily request limit to 0 in Settings, AI, and save. A new
    capture is refused with a "fill in by hand" message (`ai_limit_reached`). Clear the limit and
    save. **AI usage** now shows the calls of this part, by feature and outcome.

### H. Daily summaries with the fake providers (Phase 7)

39. As `aylin`: Settings, AI: switch **daily summaries** on; leave the summary time at 18:00 and
    the recipients supervisor and manager; save.
40. Generate summaries now (PowerShell, signed in as `aylin` with `client = 'mobile'` as in README
    section 4). Without a day it takes the last due day (today after 18:00 in the organization's
    time zone, otherwise yesterday):

    ```powershell
    Invoke-RestMethod "$api/ai/summaries/generate" -Method Post -Headers $headers -ContentType 'application/json' -Body '{}'
    ```

    The answer lists `generated` (one per supervisor and manager: `selin`, `emre`, `murat`).
    Running it again generates nothing new (`skipped`).

41. As `selin` in the browser: the Overview shows the latest summary (the text "Fake
    narrative.", labelled AI-written, the key numbers) and the unusual-items panel; Summaries
    lists it. The numbers cover North Depot only. As `emre`, his summary covers Harbour Project
    and Logistics; open `selin`'s summary URL as `emre`: "not found".
42. As `murat`: the summary covers the whole organization.
43. Notification: sign in to the emulator as `selin` (or call `GET /notifications` as `selin`
    from PowerShell): "Daily summary for <day>" in Alerts.
44. Leave the API running past 18:00 (organization time) on a day with summaries on: today's
    summaries appear by themselves within a minute or two (the scheduler), with a notification.

### I. Real providers (after obtaining the keys, section 7)

45. Put `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the root `.env`, restart the API, and check
    the log line `AI providers: llm=anthropic/claude-opus-5-5 speechToText=openai/gpt-4o-transcribe`.
46. Type a note in English, then in Turkish (for example "Kuzey depoda yangın tüplerini kontrol
    ettim, ikisi değişmeli"): the proposal picks a sensible type of work and fields, with
    confidence hints. Save one, discard one.
47. Speak in Turkish, English, and Arabic (on a phone, or the emulator with the host microphone
    on): the transcript is right and the proposal follows it. Snap a photo of a meter or a
    label: the proposal reads it.
48. Generate summaries for a day that has none yet (`-Body (@{ day = '<YYYY-MM-DD>' } |
ConvertTo-Json)`, up to 7 days back): the narrative is real text, labelled AI-written, and every
    number in it appears among the numbers shown next to it.
49. AI usage shows real token counts and an estimated cost. If anything ends "Couldn't
    understand" at once, look for `status=rejected` in the API log (wrong key, no credit, or a
    model the account cannot use).
50. Optional, after 46 to 49 work: set `AI_ANTHROPIC_REFUSAL_FALLBACK=true`, restart, and repeat
    step 46 once.

### J. Development build and push (Phase 4, optional)

51. README section 5, "The development build": Expo account, `eas init`, the project id in `.env`
    and `eas.json`, build and install the Android development build, serve it with
    `pnpm --filter @ops/mobile dev:client --clear`. Check the HZ icon and splash, the microphone
    permission text "Voice notes you record are turned into a proposed work log that you review.",
    and that an approval (step 21) and a daily summary (step 43) arrive as push notifications.

### K. Afterwards

52. Put `.env` back if you changed it for a phone test (README section 5, "Switch everything back
    afterwards"). Keep the keys in `.env` only.
53. Report the results (step numbers that failed, with what you saw) so the docs can record what
    was verified.
