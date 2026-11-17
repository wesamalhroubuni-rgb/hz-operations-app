# ADR-0012: An organization's own AI provider keys

- **Status**: Accepted
- **Date**: 2026-11-16
- **Phase**: between 7 and 8 (owner request)

## Context

Phase 7 (ADR-0010) reads the AI provider keys from the server's environment
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). The owner wants an admin to paste the organization's own
Claude key in the dashboard and start using real AI, without editing server files. A key is a
credential that bills the organization's provider account: it must not leak through answers,
logs, the audit log, the outbox, backups of the settings, or another organization.

## Decision

1. **Storage.** A table `AiProviderKey` (one row per organization and provider: `anthropic`,
   `openai`), not the organization's `settings` JSON (which `GET /organization` returns). The key
   is encrypted with AES-256-GCM (`src/platform/crypto/secret-box.ts`), a random 12-byte nonce,
   the encryption key derived with SHA-256 from `AI_KEYS_ENCRYPTION_SECRET` (at least 32
   characters; production refuses a weak one) and a purpose label. The organization id and
   provider are the associated data: a row copied elsewhere does not decrypt. The row keeps a
   hint (`…` and the last four characters) for display.
2. **Routes** (`ai_key.manage`, admins only): `GET /ai/keys` (per provider: the source in force
   — `organization`, `environment`, `test` or `none` — the hint, when it was saved, an
   `unreadable` flag, the model in use), `PUT /ai/keys/:provider` `{ apiKey }`,
   `DELETE /ai/keys/:provider` (a no-op 200 when no key is stored). No answer ever contains a
   key. Without `AI_KEYS_ENCRYPTION_SECRET`, `GET` says `storageAvailable: false` and `PUT` is
   503 `ai_key_storage_unavailable`. `unreadable` is true when a key is stored but does not
   decrypt (the secret changed or is missing): it is not used and an admin pastes it again.
3. **Checked before stored.** `PUT` asks the provider for the metadata of the model the
   organization will use (its chosen model, else the server's; `GET /v1/models/{model}`,
   Anthropic SDK `models.retrieve` / one `fetch` for OpenAI): it needs a valid key with access to
   that model, generates nothing and costs nothing. Refused (HTTP 400, 401, 403, 404, 422) → 422
   `ai_key_invalid`, nothing stored; the error detail is on path `model` for a 404 (the key may
   be valid but cannot reach the chosen model) and on `apiKey` otherwise. Unreachable or timed
   out → 503 `ai_unavailable`. Each admin may start at most 5 checks per minute (429
   `rate_limited` with `Retry-After`, in the in-memory `RATE_LIMITER`), so the route cannot be
   used to test many keys. The check is not an `AiTrace` (no model call), does not count against
   the AI limits, and is logged with ids, kind and code only.
4. **Use.** The platform's `AiProviderSelector` picks each call's providers: the organization's
   key first (provider built once per organization, model and key fingerprint, cached in memory),
   else the providers chosen at boot from the environment (ADR-0010). The keys are read for every
   call (one indexed query), so a saved, replaced or removed key applies to the next call in every
   process. Under `AI_PROVIDER=fake` organization keys are ignored (the status then shows `test`
   with the stored hint). The host binds the key reader under `AI_ORGANIZATION_KEYS`;
   `src/platform/ai` still imports nothing from `src/operations`. `AiRunner.providers()` takes
   the organization id and is async.
5. **Model choice per organization.** `settings.ai.llmModel` (one of `AI_LLM_MODEL_CHOICES`:
   `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`) and
   `settings.ai.sttModel` (`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper-1`), set by an
   admin in the AI settings card; absent means the server's `AI_LLM_MODEL` / `AI_STT_MODEL`. The
   resolver (`OrganizationAiKeys`) returns them with the keys. A chosen model applies with the
   organization's own key, and also with the server's real key (the selector builds a provider
   with that key and the chosen model); the fakes ignore it. Every choice has a row in the price
   table (`claude-fable-5-2` added at $8 / $40 per million input / output tokens).
6. **Traceability.** Saving and removing go through `ChangeRecorder` (entity `ai_provider_key`,
   verbs `created`, `updated`, `deleted`); payloads carry `{ provider, stored }` only, never the
   key or its hint. Changing the model is an ordinary `organization.updated` event.
7. **Tests never reach a provider.** The integration harness binds network-free provider
   factories (`AI_REAL_PROVIDER_FACTORIES`); a suite that needs them scripts them.

## Reasons

- An admin can switch to real AI from the dashboard; the server's environment key still works for
  operators who prefer it, and the test AI keeps working without any key.
- Encryption with bound associated data protects the key in database dumps and against row
  copying; the secret lives only in the server's environment.
- Checking before storing turns a mistyped key into an immediate message instead of failed
  summaries later.

## Tradeoffs

- Anyone with both the database and `AI_KEYS_ENCRYPTION_SECRET` can read the keys; that is the
  server's trust boundary (as for every other secret in `.env`).
- Changing `AI_KEYS_ENCRYPTION_SECRET` makes stored keys unreadable (logged as `ai key
unreadable`, treated as no key); admins paste them again. No key rotation in v1.
- One extra query per AI call. Negligible next to a model call.
- The model choice is a fixed list in `@ops/shared`; a new model needs a code change (the list,
  the price row, the dashboard label). A key without access to the chosen model is refused at
  save time, but a model changed after the key was saved is not re-checked: the next calls then
  fail as `rejected` until the admin picks another model or key.
- The key-check limit is in memory per process, like the other rate limits (Phase 8: shared
  store).

## Alternatives considered

- **Keys in `settings.ai`**: returned by `GET /organization`, copied into the audit `before` /
  `after`, readable by every admin forever. Rejected.
- **An external secret manager (Vault, cloud KMS)**: stronger, but a new runtime dependency for a
  one-organization pilot. The `SecretBox` interface can be backed by a KMS later.
- **Check the key with a tiny generation**: costs tokens and needs the limits; the metadata read
  proves the same (valid key, model access) for free.
