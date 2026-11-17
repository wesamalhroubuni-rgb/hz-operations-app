# ADR-0014: Smart capture answers fields as a list, and polishes the note in its own language

- **Status**: Accepted
- **Date**: 2026-11-17
- **Phase**: between 7 and 8 (found with the first real Claude call; owner request for the note)
- **Amends**: [ADR-0010](0010-ai-layer-architecture.md) section 5 (the shape of the capture
  output schema) and the `text` rule of the `smart-capture-extract` prompt

## Context

ADR-0010 section 5 built the capture output schema as a union over the offered log types, each
with every custom field present and nullable (`null` = not said). Until 2026-11-17 only the fake
LLM had answered it. The first call to the real Claude (`claude-opus-5-5`, with an
organization's own key, ADR-0012) was refused with HTTP 400: Anthropic's structured outputs
accept at most 16 union-typed parameters (a type array or `anyOf`, which includes every nullable
value) per schema, and the demo organization's log types produced 33. The number grows with
every field an organization adds, so no fixed set of log types would have stayed under the limit.

Separately, the owner wanted the proposed log text to read as a clean note, not a raw transcript,
without the AI changing the worker's language.

## Decision

1. **Field values are a list.** The model's answer (`CaptureModelOutput`,
   `buildCaptureOutputSchema` in `packages/shared/src/domain/ai-capture-output.ts`) is:
   `logTypeKey` (an offered key or null), `logTypeConfidence`, `fields` (an array of
   `{ field: '<logTypeKey>.<fieldKey>', value, confidence }`, one entry shape per offered field:
   the field name as a constant, the value typed by the field, select options as enums, dates as
   ISO dates), `taskRef` and `siteRef` (offered references or null) with their confidences,
   `text` (or null) with its confidence, and `occurredAt` (or null). A value the input does not
   state is simply absent from the list.
2. **Confidences are never null.** The code ignores the confidence of a value that is null or
   absent; the prompt asks for `low` there.
3. **At most six union-typed parameters**, whatever is offered (`logTypeKey`, the `fields` entry
   union, `taskRef`, `siteRef`, `text`, `occurredAt`). A unit test in
   `packages/shared/src/domain/ai-contracts.test.ts` counts them in the JSON Schema and fails above
   six.
4. **Interpretation** (`interpretCaptureOutput`): the first entry per field name wins; entries of
   a log type other than the chosen one are ignored; each value is still checked against its
   field rule and dropped if it fails. Nothing else about the proposal, the review on the phone,
   or the confirm path changed.
5. **Prompt versions.** `smart-capture-extract.v2.md` describes the list format;
   `smart-capture-extract.v3.md` (in use, `CAPTURE_EXTRACT_PROMPT` version 3 in
   `smart-capture.service.ts`) adds: `text` is the worker's report as a polished note (spelling,
   grammar, punctuation, filler and repetitions removed, every fact, number and name kept, no
   facts added), **in the same language the worker used, never translated** (mixed input: the
   language most of it is in). v1 and v2 stay in the folder because traces refer to them.

## Reasons

- The list keeps the union count constant, so the schema stays valid for any number of log types
  and fields, within the 20 log types the capture offers (`AI_CAPTURE_MAX_LOG_TYPES`).
- Every value is still constrained by its field's type, options and the offered references, so
  the "an injection has nothing to win" argument of ADR-0010 section 4 holds unchanged.
- A polished note saves the worker the clean-up; keeping the language avoids a log written in a
  language its author or reviewer may not read. The worker still reviews every field, and the
  transcript stays visible in the review.

## Tradeoffs

- The schema no longer forces the model to consider every field; a stated value can be left out.
  The worker's review is the safeguard, as before.
- A model could list the same field twice or list fields of another log type; the code resolves
  both (first wins, others ignored) instead of the schema preventing them.
- The proposed text is a rewrite of the worker's words, not a verbatim record. It is labelled
  AI-suggested and only saved when the worker saves the form.

## Alternatives considered

- **Keep the union of log types and offer fewer of them per call** (for example only the open
  context's log type): still over the limit for one log type with more than about a dozen
  nullable fields, and it loses the model's choice of log type.
- **One call to pick the log type, a second to fill its fields**: two calls per capture (cost,
  latency, two traces) and the second schema can still exceed the limit for a large log type.
- **Drop structured output and validate free JSON**: invalid answers become more likely and every
  one costs a retry; the Zod validation already runs either way.

## Consequences

- A change to the capture output schema must keep the union count at or under the test's bound.
- A change to the prompt is a new version file (`v4`), never an edit of v3 (AGENTS.md).
- As reported for 2026-11-17: a real capture with `claude-opus-5-5` succeeded and the English
  polishing was checked; Turkish and Arabic runs were stopped by the organization's own daily
  request limit (set to 9 in Settings), so the language rule is not yet checked on real Turkish
  or Arabic input.
