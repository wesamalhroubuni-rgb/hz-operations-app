/**
 * The price table behind every cost estimate of the AI layer (ADR-0010 section 7). Estimates
 * feed the per-organization daily cost limit and the usage report; they are not invoices.
 * Update this table when a provider changes its prices or the owner configures another model:
 * a model missing here is estimated as null (counted as $0 against the limit). When the model
 * that answered is missing (a server-side fallback model), the runner estimates the call at the
 * configured model's price instead.
 *
 * Sources:
 * - Claude models: Anthropic's model and pricing table as cached in the Claude API reference on
 *   2026-10-06 (checked 2026-11-01): Opus 5.5 $4 / $20, Sonnet 5.5 $2 / $10, Haiku 5.5
 *   $0.10 / $0.50 per million input / output tokens (Haiku 5.5: prompts up to 100K tokens).
 * - OpenAI speech-to-text: OpenAI's published pricing at the time of writing (to re-check
 *   before production): gpt-4o-transcribe $6 per million audio input tokens and $10 per
 *   million output tokens, about $0.006 per minute; gpt-4o-mini-transcribe about $0.003 per
 *   minute; whisper-1 $0.006 per minute.
 * - Fakes (`fake-*`): $10 per million tokens both ways, so cost limits can be tested.
 */

export interface ModelPrice {
  /** US dollars per million input tokens (text, image or audio tokens as the provider counts). */
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
  /** US dollars per minute of audio, for speech-to-text billed or estimated by duration. */
  perAudioMinute?: number;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': { inputPerMillionTokens: 4, outputPerMillionTokens: 20 },
  'claude-sonnet-5-5': { inputPerMillionTokens: 2, outputPerMillionTokens: 10 },
  'claude-haiku-5-5': { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.5 },
  'claude-opus-5': { inputPerMillionTokens: 5, outputPerMillionTokens: 25 },
  'claude-sonnet-5': { inputPerMillionTokens: 2, outputPerMillionTokens: 10 },
  'claude-opus-4-8': { inputPerMillionTokens: 5, outputPerMillionTokens: 25 },
  'claude-haiku-4-5': { inputPerMillionTokens: 1, outputPerMillionTokens: 5 },
  'gpt-4o-transcribe': {
    inputPerMillionTokens: 6,
    outputPerMillionTokens: 10,
    perAudioMinute: 0.006,
  },
  'gpt-4o-mini-transcribe': { perAudioMinute: 0.003 },
  'whisper-1': { perAudioMinute: 0.006 },
};

/** Price of the deterministic fakes (any model name starting with `fake-`). */
export const FAKE_MODEL_PRICE: ModelPrice = {
  inputPerMillionTokens: 10,
  outputPerMillionTokens: 10,
};

export function priceOf(model: string): ModelPrice | null {
  if (model.startsWith('fake-')) {
    return FAKE_MODEL_PRICE;
  }
  return Object.prototype.hasOwnProperty.call(MODEL_PRICES, model) ? MODEL_PRICES[model]! : null;
}

/** Rounds to the trace column's precision (Decimal(12, 6)). */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Estimated cost of an LLM call by tokens; null when the model is not in the table. */
export function estimateTokenCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): number | null {
  const price = priceOf(model);
  if (
    !price ||
    price.inputPerMillionTokens === undefined ||
    price.outputPerMillionTokens === undefined
  ) {
    return null;
  }
  return roundUsd(
    (usage.inputTokens * price.inputPerMillionTokens +
      usage.outputTokens * price.outputPerMillionTokens) /
      1_000_000,
  );
}

/**
 * Estimated cost of a transcription: by tokens when the provider reported tokens and the table
 * prices them, otherwise by audio minutes. Null when neither is possible.
 */
export function estimateTranscriptionCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; audioSeconds: number },
): number | null {
  const price = priceOf(model);
  if (!price) {
    return null;
  }
  if (usage.inputTokens + usage.outputTokens > 0) {
    const byTokens = estimateTokenCostUsd(model, usage);
    if (byTokens !== null) {
      return byTokens;
    }
  }
  if (price.perAudioMinute !== undefined) {
    return roundUsd((Math.max(0, usage.audioSeconds) / 60) * price.perAudioMinute);
  }
  return estimateTokenCostUsd(model, usage);
}
