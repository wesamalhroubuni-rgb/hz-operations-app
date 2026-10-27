WORKING DIRECTORY: the repository root you are running in (state it at the start).

PHASE 7 of 8 — Intelligent layer v1: smart capture and daily AI summaries

## Start of session
Follow AGENTS.md: read AGENTS.md → MEMORY.md → ARCHITECTURE.md → ROADMAP.md → all ADRs → folder memory files of everything you will touch. Confirm a green start; fix anything that fails first.

## Goal
Make HZ more than a logging tool, without making it less reliable:
1. **Smart capture:** a worker records a voice note (Turkish, English or Arabic) or takes a photo, and the app proposes a structured work log (log type, custom fields, text, task/site) for the worker to review and confirm. Nothing is saved without the worker confirming.
2. **Daily summaries:** each supervisor/manager receives an automatic daily summary of their scope — what got done, what is late or blocked, unusual items (e.g. no activity at a site, a task taking much longer than similar ones, many rejections) — in the dashboard and as a notification.

## Architecture rules (critical)
- The core app must work fully with AI switched off or failing. AI is a separate layer: it consumes outbox events and calls the normal API services; it never writes to the database directly or bypasses permissions, audit or outbox.
- **Permissions:** the AI only ever sees data the requesting/receiving user may see (use the Phase 2/3 scope service). A summary for selin contains only selin's scope.
- **Providers behind interfaces** (reusable Kaneri platform components): an LLM provider interface and a speech-to-text provider interface, selected by configuration. Implement:
  - LLM: Anthropic Claude via the official SDK, model name from env.
  - Speech-to-text: pick one provider that handles Turkish, English and Arabic well; justify it in the ADR.
  - A deterministic **fake provider** for each, used in tests and whenever API keys are missing, so the whole app runs and tests pass without keys.
- API keys only from environment variables; document them in .env.example (empty values). I will add real keys later.
- **Structured outputs:** the model returns JSON validated against the log type's custom-field schema (shared Zod). Invalid output → retry once, then fall back to "couldn't understand, please fill in manually" with the transcript kept.
- **Traceability:** store for each AI action: provider, model, prompt version, input references, output, latency, token usage/cost estimate, and the user who confirmed or discarded it. AI-proposed logs are marked `source: ai_assisted` with metadata (the field reserved in Phase 2).
- **Safety and cost:** per-organization on/off switches for each feature, daily usage limits, timeouts, rate limits, and no personal data sent beyond what the task needs (e.g. don't send emails/phone numbers to the model). Prompts are versioned files, not strings scattered in code. Treat user text and transcripts as data, never as instructions to the model (prompt-injection safe: they cannot change the summary recipient, scope or actions).
- Offline: voice notes and photos recorded offline are queued (Phase 5 queue) and processed when online; the worker can still fill the form manually at any time.

## Features
- **Mobile:** "Speak" and "Snap" buttons on the New log screen and home; show the transcript and the proposed form side by side with confidence hints; worker edits and confirms. Clear indication that content is AI-suggested.
- **Daily summaries:** scheduled job per organization time zone (configurable time, default 18:00), generated from the day's events in scope; stored and shown on the dashboard Overview (history browsable); sent via the notification-channel interface (in-app + push). Include deterministic statistics computed in code (counts, overdue) and let the model write the narrative from those facts — numbers must come from code, not the model.
- **Anomaly flags v1 (rule-based, explainable):** no activity at an active site, task duration far above the median for its log type/site, repeated rejections for one worker, logs far from the site's usual location. Shown in summaries and on the dashboard with the reason. No automatic actions — suggestions only, a human decides.
- **Admin settings:** turn features on/off, summary time, recipients by role, usage limits; view AI usage.

## Out of scope
Autonomous actions (reassigning tasks, messaging workers), natural-language Q&A over data (v2), WhatsApp/Telegram/email channels (the notification interface should make them easy later).

## Before building
State: business objective, expected behavior, components affected, data required, integrations, failure cases, test plan. Write ADR-0010 (AI layer architecture, providers, data handling, cost controls) and ADR-0011 (daily summaries and anomaly rules). Then proceed without waiting for approval.

## Subagents
- In parallel after contracts are agreed: one for the AI platform layer (provider interfaces, fakes, tracing, limits, prompt files), one for smart capture (API + mobile), one for daily summaries + anomaly rules + dashboard/notification integration.
- `test-writer`: scope isolation in summaries (a supervisor never sees out-of-scope data), invalid model output handling, fake-provider end-to-end, prompt-injection attempts in transcripts, numbers in summaries match code, feature switches and limits, offline-queued voice notes, AI off → app fully functional.
- `reviewer`: against this prompt, AGENTS.md, Phase 3 security rules and data-protection concerns; fix findings.
- `docs-keeper`: MEMORY, ARCHITECTURE, ROADMAP (Phase 7 done-when), ADRs, README (including which API keys to add and where), folder memory files.

## When finished
Run all checks with the fake providers, give the end-of-change summary from AGENTS.md, list exactly which API keys I need to obtain and where to put them, and give a full manual test plan for Phases 4–7 together (web + Android emulator or phone), since I will test everything at once after this phase.
