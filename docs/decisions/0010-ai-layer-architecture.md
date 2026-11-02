# ADR-0010: AI layer architecture, providers, data handling, and cost controls

- **Status**: Accepted
- **Date**: 2026-10-30
- **Phase**: 7

## Context

Phase 7 (`docs/prompts/phase-7.md`) adds the first AI features: **smart capture** (a worker's
voice note in Turkish, English or Arabic, a photo, or a typed note becomes a proposed work log the
worker reviews and confirms) and **daily summaries** with rule-based anomaly flags (ADR-0011). The
core must keep working with AI switched off or failing; the AI may only see what the requesting or
receiving user may see; every AI action must be traceable; providers must sit behind interfaces
with deterministic fakes so everything runs and is tested without keys. The work is split between
a contracts step (this ADR, ADR-0011, the shared schemas, the Prisma change, the environment and
the interface files) and three agents in parallel: **A** (AI platform layer), **B** (smart
capture, API and mobile) and **C** (summaries, anomalies, dashboard and notifications).

### Before building (AGENTS.md statement)

1. **Business objective.** Make logging faster and richer for workers (speak or snap instead of
   typing, in their own language) and give supervisors and managers an end-of-day picture of
   their scope with the unusual items called out, without making the product less reliable or
   leaking data across scopes.
2. **Expected behaviour.** "Speak" and "Snap" on the phone's New log screen and home (only when
   the organization switched smart capture on). The phone shows the transcript and the proposed
   form side by side, with a confidence hint per field and a clear "AI-suggested" marker; the
   worker edits and confirms (an ordinary work-log create) or discards. Nothing is saved without
   confirmation. When the AI cannot make sense of the input, the worker sees "Couldn't
   understand, please fill in manually" with the transcript kept. Offline, recordings queue and
   are processed when the phone is back online; the form can always be filled by hand. Captures
   waiting for review count as unfinished work at sign-out, like queued writes (sync first /
   keep for later / discard). Daily
   summaries: ADR-0011. Admins switch each feature on or off, set the summary time, recipients
   and usage limits, and see AI usage.
3. **Components affected.** `apps/api`: `src/platform/ai/` (new, reusable), `src/operations/ai/`
   (new), the work-log create path, the access layer (`runAsUser`), the organization summary,
   the environment. `@ops/shared`: AI contracts, settings, error codes. `apps/mobile`: capture
   UI, audio recording, a queue kind. `apps/web`: overview panels, admin AI settings and usage.
   Prisma: `SmartCapture`, `DailySummary`, `AnomalyFlag`, `AiTrace`, `WorkLogSource.ai_assisted`.
4. **Data required.** The worker's input (audio, photo, text), the log types and their field
   definitions, the worker's open assigned tasks and visible sites (names only), the
   organization's time zone; for summaries, counts computed in code (ADR-0011). Every AI call
   writes an `AiTrace` row.
5. **External integrations.** Anthropic Claude (Messages API, official `@anthropic-ai/sdk`) for
   proposals, photo understanding and summary narratives; OpenAI speech-to-text
   (`/v1/audio/transcriptions`, plain `fetch`) for voice notes. Both optional.
6. **Failure cases.** No key (fake in development and test; "unavailable" in production);
   provider error or timeout (capture: 503 `ai_unavailable`, the capture stays `pending` and the
   phone retries; summary: template narrative); the provider rejecting the request itself (HTTP
   400, 401, 403, 404, 422: capture `failed` with `provider_rejected`, summary template, an
   error log line); invalid model output (one retry, then capture
   `failed` with `output_invalid` and the transcript, summary template); refusal; daily limit or
   cost limit reached (429 `ai_limit_reached`, summary template); per-user rate limit (429
   `rate_limited`); feature off (403 `ai_disabled`); unusable upload (capture `failed`,
   `input_unusable`); prompt injection in a transcript, a note or a task title (no effect beyond
   the proposal the worker reviews, see below); the phone offline (queued).
7. **Test plan.** Fakes everywhere (no key in CI). Unit: output schema builder (done in the
   contracts step), number validation of narratives, rules, prompt loader, limiter, runner retry
   and failure mapping, redaction of keys. Integration: capture flow per input kind and failure
   (invalid output twice, provider down, refusal, limits, switch off, another worker's capture is
   404, confirm with `aiProposalId` and its metadata, confirm twice is 409); summaries contain
   only the recipient's scope (two supervisors, changed scopes); numbers in narratives equal the
   stats; anomaly rules with their thresholds; outbox handler idempotent; AI off: every Phase 1-6
   suite unchanged. Mobile: offline-queued voice note processed on reconnect, manual fill while
   waiting. Matrix rows for every new policy.

## Decision

### 1. Two layers

- **`apps/api/src/platform/ai/`** (reusable Kaneri component, no `src/operations` import):
  `LlmProvider` and `SpeechToTextProvider` interfaces (`llm-provider.ts`,
  `speech-to-text-provider.ts`), the provider registry (chooses real or fake from `AI_PROVIDER`
  and the keys), `AiRunner` (the one entry point for features: limits, timeout, the one retry,
  structured-output validation, tracing), `AiTraceService` (writes `AiTrace`, answers usage),
  the usage limiter, `PromptLoader` and `untrustedDataBlock`. Contract: `ai-types.ts`.
- **`apps/api/src/operations/ai/`**: smart capture (`capture/`), summaries (`summaries/`),
  anomaly rules (`anomalies/`), the versioned prompt files (`prompts/`), and the host bindings
  (`AI_ORGANIZATION_LIMITS` from `settings.ai`, the prompt folder). They read through the normal
  services and visibility filters and write only in the normal `prisma.$transaction` +
  `ChangeRecorder.record` pattern. The platform layer writes only `AiTrace`.
- The AI layer never writes a business record on its own: a work log exists only when the worker
  sends `POST /work-logs`; summaries and flags are the AI layer's own records, written by the
  operations code under `runAsSystem` (audit actor `system`).

### 2. Providers

- **LLM: Anthropic Claude**, official `@anthropic-ai/sdk` pinned to an exact version, model from
  `AI_LLM_MODEL`, **default `claude-opus-5-5`** (Anthropic's current default recommendation for
  this kind of extraction and writing work, with image input; $4 / $20 per million input / output
  tokens at the time of writing). The owner may set a cheaper model (for example
  `claude-haiku-5-5`) in `AI_LLM_MODEL` without a code change; the price table in the platform
  layer must then know it. Calls use `client.messages.create` with
  `output_config: { format: { type: 'json_schema', schema } }` for structured output and
  `output_config.effort: 'low'` (short extraction and narrative; thinking cannot be disabled on
  this model, so `max_tokens` leaves room for it), the SDK's `maxRetries: 0` and the runner's
  timeout as an `AbortSignal`. Refusals (`stop_reason: 'refusal'`) are the failure `refused`.
  The server-side refusal fallback (`fallbacks: 'default'`, beta
  `server-side-fallback-2026-07-01`) is behind the switch `AI_ANTHROPIC_REFUSAL_FALLBACK`
  (default **false**): enable it only after checking it with a real key. The model that actually
  answered (`response.model`) is recorded in the trace; when it is missing from the price table,
  the call is estimated at the configured model's price.
- A provider answer of HTTP 400, 401, 403, 404 or 422 (a bad key, an unknown model, a request
  the provider will never accept) is the failure `rejected`, not `unavailable`: smart capture
  ends the capture `failed` with `failureReason: 'provider_rejected'` (the phone shows "Couldn't
  understand, please fill in manually"), summaries use the template, and the runner logs it as
  an error (ids and code only) so an operator notices. 408, 409, 429, 5xx, network errors and
  timeouts stay retryable (`unavailable` / `timeout`); 413 stays `input_rejected`.
  Photo "Snap" sends the re-encoded JPEG as a base64 image block (Claude vision); no separate
  vision provider.
- **Speech-to-text: OpenAI `gpt-4o-transcribe`** (model from `AI_STT_MODEL`), multipart `POST
/v1/audio/transcriptions` through plain `fetch` (one endpoint; the SDK would add a dependency for
  nothing), with the language hint from the worker's app language and automatic detection. It
  accepts the formats the phone records (`audio/mp4` / m4a) and the web's (`webm`, `ogg`, `wav`,
  `mpeg`), up to 25 MB per file (the API's own limit is 8 MiB and two minutes).
- **Fakes**: `FakeLlmProvider` (`fake` / `fake-llm-1`) and `FakeSpeechToTextProvider` (`fake` /
  `fake-stt-1`), deterministic and offline:
  - Fake STT: if the audio bytes contain the ASCII marker `FAKE-STT:` the transcript is the UTF-8
    text after it (up to a NUL byte or the end); otherwise `"Fake transcript"`. Language: the
    hint, else `en`. Duration: from the request's declared duration when the caller passes it,
    else 1 second.
  - Fake LLM: if the user content contains `FAKE-LLM-JSON:` followed by a JSON value (to the end
    of that data block), it answers exactly that text (tests inject valid, invalid and hostile
    answers this way); `FAKE-LLM-INVALID` answers `not json`; `FAKE-LLM-REFUSE` answers a
    refusal; `FAKE-LLM-FAIL` rejects with `AiProviderError('http_529')`; `FAKE-LLM-SLOW` waits
    for the abort signal. Otherwise, for `json_schema` it answers the smallest valid instance of
    the schema (every nullable value null, also where another union variant is as short, and the
    `null` log-type variant) and for text the fixed
    narrative `"Fake narrative."` (no digits, so it passes number validation).
  - Usage: tokens = ceil(characters / 4) of input and output; price `fake-*` = $10 per million
    tokens both ways, so cost limits can be tested.
- **Selection** (`AI_PROVIDER`): `auto` (default) uses the real provider for each kind whose key
  is set and the fake otherwise, except in production, where a kind without a key is
  **unavailable** (calls fail with `unavailable`: capture answers 503, summaries use the
  template). `fake` uses both fakes and is refused in production. `real` requires both keys at
  boot. Fakes in production would put invented proposals and narratives in front of real users,
  so they never run there.

### 3. Data handling: what is sent, what never is

| Sent to                 | What                                                                                                                                                                                                                                                                                                                              | Never                                                                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI (speech-to-text) | the audio bytes, a neutral file name (`capture.m4a`), the language hint                                                                                                                                                                                                                                                           | user, organization or capture ids, names, any other context                                                                                                                       |
| Anthropic (capture)     | the transcript or typed text or photo note, the photo (re-encoded, EXIF stripped), the worker's active log types (key, name, field keys, labels, types, options, help text), up to 30 open assigned tasks (title, as `T1`...), up to 30 visible sites (name, as `S1`...), the organization's time zone and the local capture time | database ids, the worker's name, e-mail, phone or username, other people, other workers' logs, storage keys or URLs                                                               |
| Anthropic (summary)     | the facts computed in code (counts, site and team names, completed task titles, anomaly reasons with their numbers), people as references (`P1`...), the recipient's language                                                                                                                                                     | names, e-mail addresses, phone numbers of anyone (the code substitutes display names for `P1`... after validation), log free text, photos, anything outside the recipient's scope |

- The organization's AI is off by default (`settings.ai`); turning it on is an admin decision.
- Provider data policies at the time of writing: neither Anthropic's nor OpenAI's API trains on
  API data by default; both keep request data for a limited period for abuse monitoring, and
  both offer zero-data-retention terms to eligible customers. The owner should confirm the
  current terms and, for production, request zero retention where available and sign the data
  processing agreements. Recorded as an open item for Phase 8.
- **Retention in HZ**: capture input bytes (audio, photo) are deleted 30 days after the capture
  was created or 7 days after it was confirmed or discarded, whichever is first
  (`inputPurgedAt` set, the row stays). A capture's `transcript`, `proposal` and `confidence` are
  cleared 90 days after creation (the confirmed work log keeps its own content). `AiTrace.output`
  is cleared after 90 days; trace rows are deleted after 400 days (usage history). Daily
  summaries and anomaly flags are kept like other business records.
- Audit and outbox payloads of a capture carry its ids, status, input kind, failure reason, trace
  ids and work-log id, **not** the transcript or the proposal (the audit log is append-only and
  would keep them forever); the work log created from it is audited as usual. A daily summary's
  audit payload carries ids, day, narrative source, trace ids and counts, not the narrative.
- Keys are read only through `ConfigService`, never logged, never in an error message, a trace,
  or a response. Logs of AI calls carry ids, feature, status, latency and error codes only.

### 4. Prompts and prompt-injection safety

- Prompts are versioned files `apps/api/src/operations/ai/prompts/<id>.v<N>.md` with a header
  (`id`, `version`, `purpose`, see `LoadedPrompt` in `ai-types.ts`), loaded and cached by the
  platform `PromptLoader`; the nest build copies them next to the compiled code (and the seed
  build too). A used prompt is never edited; a change is a new version, and the trace records
  `promptId`, `promptVersion` and the file's SHA-256 in `inputRefs`.
- User text, transcripts, photo notes, task titles and site names go into the messages only
  inside `untrustedDataBlock(name, content)` blocks (escaped so they cannot close the block).
  Every system prompt says that block contents are data, never instructions.
- More importantly, the design leaves an injection nothing to win: the model has no tools; its
  capture answer must match a schema built from the offered log types, options and references
  (`buildCaptureOutputSchema`), ids are mapped back by the code, and the result is only a
  proposal the worker reviews; the summary's recipient, scope and facts are fixed by the code
  before the call, the narrative is plain text whose numbers must be among the facts, and people
  are named only through references the code resolves. Clients render AI text as plain text
  (no HTML, no Markdown links).

### 5. Structured output and retry

- The capture output schema is built per capture from the log types' field definitions
  (`buildCaptureOutputSchema` in `@ops/shared`): a union over the offered log types, each with
  every field present (`null` = not said), select options as enums, dates as ISO dates, tasks
  and sites as enums of references, a confidence level (`high` / `medium` / `low`) per field.
  `toStructuredOutputJsonSchema` turns it into the JSON Schema subset structured outputs accept;
  the answer is parsed and validated with the Zod schema, then `interpretCaptureOutput` maps
  references to ids and checks each value against its field rule (a failing value is dropped).
- Invalid output (unparsable, schema mismatch, `validate` refusing, cut at `max_tokens`): one
  retry with the reason added; still invalid: the capture becomes `failed` with
  `failureReason: 'output_invalid'` and the transcript kept, answered with 200 (it is a normal
  outcome, not an error code). Both attempts are traced.

### 6. Smart capture flow and contract

- `POST /ai/capture` (`clientId`, idempotent), `POST /ai/capture/:id/upload-url`,
  `POST /ai/capture/:id/process`, `GET /ai/capture`, `GET /ai/capture/:id`,
  `POST /ai/capture/:id/discard`, policy `ai_capture.use` (every role; own captures only, others
  404). Shapes and the step-by-step flow: `packages/shared/src/domain/ai-capture.ts`.
- Audio and photo inputs reuse the storage platform (`FileStorage`, signed PUT with type and
  size, an API-chosen key `ai-captures/<organizationId>/<captureId>`) but **not** the
  `Attachment` table: attachments belong to an existing work log, and a capture exists before
  its log. The capture row holds the key (never sent to a client). Processing verifies the bytes:
  photos through the existing image verification (decode, re-encode, EXIF stripped) before
  anything is sent to the model; audio by magic bytes of the declared type and the stored size.
  A Snap photo the worker wants on the log is attached afterwards through the ordinary photo
  upload from the phone's local copy.
- Processing a capture: re-check the context ids against the worker's visibility (drop, never
  error), collect the offered log types, tasks and sites, transcribe (voice), extract, interpret,
  store `proposed` or `failed`. A lease (`processingUntil`, three provider timeouts) stops two
  calls processing at once; a repeat after the end returns the stored result.
- Confirming is `POST /work-logs` with `source: 'ai_assisted'` and `aiProposalId`. The API
  checks the capture is the caller's and `proposed` or `failed` (else 422; already confirmed by
  another log 409 `conflict`), marks it `confirmed` with `workLogId` in the same transaction,
  writes `aiMetadata` itself (`aiWorkLogMetadataSchema`: capture and trace ids, input kind,
  model, prompt version, kept / changed / added fields from `compareWithProposal`), and stamps
  the decision on the traces. A client may send only `manual` or `ai_assisted` as source;
  `WorkLogSource.ai` is renamed `ai_assisted` (no rows used it). Offline, the confirmation is an
  ordinary queued create (the capture already exists on the server).
- Discarding records the decision on the capture and its traces (`decidedById`, `decidedAt`).

### 7. Cost and abuse controls

- Organization switches (`settings.ai.smartCaptureEnabled`, `dailySummaryEnabled`, both false by
  default): 403 `ai_disabled` when off. The organization summary carries `aiFeatures` so the
  phone shows Speak and Snap only when on.
- Daily limits per organization and UTC day, counted from `AiTrace` (calls, and estimated cost
  from a price table in the platform layer): the lower of `AI_DAILY_LIMIT_PER_ORG` /
  `AI_DAILY_COST_LIMIT_USD_PER_ORG` and the organization's `dailyRequestLimit` /
  `dailyCostLimitUsd`. Over the limit: 429 `ai_limit_reached` (final for that request; the phone
  says fill in by hand), summaries fall back to the template.
- Per-user rate limit `AI_RATE_LIMIT_PER_USER_PER_MINUTE` (in memory per process, like the other
  rate limits): 429 `rate_limited` with `Retry-After`.
- Timeouts: `AI_REQUEST_TIMEOUT_MS` per provider call; the phone's client timeout for capture
  calls is 120 s (`AI_CAPTURE_CLIENT_TIMEOUT_MS`). Input caps: voice 2 minutes and 8 MiB, text
  4,000 characters, photo the upload limit, at most 20 log types, 30 tasks, 30 sites offered.
- `GET /ai/usage` (admins, `ai_usage.read`): calls, outcomes, tokens, audio seconds and
  estimated cost per day, feature, provider and model, today's totals against the limits, and the
  providers in force.

### 8. Background context

`AccessService.runAsUser(organizationId, userId, work)` runs `work` with exactly that user's
resolved scope, read-only (`authorOf` refuses it), outside a signed-in request (also inside an
outbox handler's actor-less context). ADR-0011 uses it to compute a recipient's summary through
the same filters as the dashboard.

## Reasons

- An interface per provider kind plus deterministic fakes keeps the AI optional, testable in CI
  without keys, and replaceable; one runner owns limits, timeouts, retries and tracing so no
  feature can skip them.
- Claude handles structured extraction, Turkish and Arabic text and images in one model, with
  structured outputs that make schema-valid answers the normal case.
- Building the output schema from the log types' own definitions means the model can only
  propose values a form accepts, and the same Zod schema validates the answer.
- `gpt-4o-transcribe` was chosen for speech-to-text because, at the time of writing, OpenAI's
  published results show it ahead of Whisper large-v3 on the multilingual FLEURS benchmark,
  including Turkish and Arabic; it needs no infrastructure; it costs about $0.006 per minute
  (a two-minute note about one cent); it accepts the phone's m4a directly; and its API terms
  (no training on API data by default, zero retention available to eligible customers) are
  comparable to Anthropic's.

## Tradeoffs

- Two external providers, two keys, two data processors. Mitigated by keeping both optional and
  sending each the minimum.
- `claude-opus-5-5` costs more per call than the small models; it was kept as the default for
  quality, and the model is one environment variable away from a cheaper one.
- Snap photos are uploaded twice when the worker also attaches the photo to the log (once as
  capture input, once as attachment); in exchange the attachment rules stay unchanged.
- Usage limits count per UTC day, not the organization's day, and the per-user rate limit is per
  process: simple, slightly coarse.
- The fakes answer to markers in the input. That is test-only behaviour and fakes are refused in
  production.

## Alternatives considered

- **Self-hosted Whisper (large-v3)**: no audio leaves our servers and no per-minute cost, but it
  needs a GPU host to be fast enough, more operations work, and its Arabic and Turkish accuracy
  trails `gpt-4o-transcribe` in published results. Worth revisiting if data residency demands it.
- **Google Cloud Speech-to-Text (Chirp 2)**: good multilingual quality, but a Google Cloud
  project, service accounts and regional configuration for one feature.
- **Deepgram (Nova-3)**: fast and inexpensive, strongest in English; its Turkish and Arabic
  coverage was less proven at the time of writing.
- **ElevenLabs Scribe**: strong multilingual accuracy, including Turkish and Arabic, at a
  comparable price; a newer API and an additional vendor relationship. The runner-up; switching
  is one adapter behind `SpeechToTextProvider`.
- **Sending audio straight to the LLM**: no Claude model takes audio input; a separate
  transcription step also gives the worker a transcript to check.
- **Captures as `Attachment` rows with a nullable `workLogId`**: would weaken the attachment
  visibility rule (built on the parent log) for every photo. Rejected.
- **A tool-calling agent that creates the log itself**: contradicts "nothing is saved without the
  worker confirming". Rejected.

## Consequences

- New tables `SmartCapture`, `DailySummary`, `AnomalyFlag` (operations) and `AiTrace` (platform),
  migration `20261030090000_phase7_ai`; `WorkLogSource.ai` renamed `ai_assisted`.
- New policies `ai_capture.use`, `ai_summary.read`, `ai_summary.generate`, `ai_anomaly.read`,
  `ai_usage.read`; new error codes `ai_disabled` (403), `ai_limit_reached` (429),
  `ai_unavailable` (503, retryable).
- New environment variables (all optional): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AI_PROVIDER`,
  `AI_LLM_MODEL`, `AI_STT_MODEL`, `AI_REQUEST_TIMEOUT_MS`, `AI_DAILY_LIMIT_PER_ORG`,
  `AI_DAILY_COST_LIMIT_USD_PER_ORG`, `AI_RATE_LIMIT_PER_USER_PER_MINUTE`,
  `AI_SUMMARY_SCHEDULER_ENABLED`, `AI_SUMMARY_POLL_INTERVAL_MS`, `AI_ANTHROPIC_REFUSAL_FALLBACK`.
- The price table must be updated when providers change prices or the owner picks another model.
- Before production (Phase 8): provider data agreements and zero retention, a shared store for
  the rate limit when scaling out, a review of the prompts with real Turkish and Arabic samples.
