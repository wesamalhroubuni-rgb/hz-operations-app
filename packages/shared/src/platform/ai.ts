import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { dayKeySchema } from '../common/time-zone.js';
import { isoDateTimeSchema } from '../common/primitives.js';

// The wire contract of the AI platform layer (Phase 7, ADR-0010): what an AI call is traced as,
// and the admin's usage report. The platform layer knows feature names only as strings; the
// names below are the ones HZ's operations features use.

/** Outcome of one provider call. Must match the Prisma enum `AiTraceStatus`, in order. */
export const AI_TRACE_STATUSES = ['ok', 'invalid_output', 'failed', 'timeout', 'limited'] as const;
export const aiTraceStatusSchema = z.enum(AI_TRACE_STATUSES);
export type AiTraceStatus = z.infer<typeof aiTraceStatusSchema>;

/** A human's decision on a proposal. Must match the Prisma enum `AiDecision`, in order. */
export const AI_DECISIONS = ['confirmed', 'discarded'] as const;
export const aiDecisionSchema = z.enum(AI_DECISIONS);
export type AiDecision = z.infer<typeof aiDecisionSchema>;

/**
 * The traced features (`AiTrace.feature`). Each AI provider call is exactly one of these.
 * - `capture_transcription`: speech-to-text of a voice note.
 * - `capture_extraction`: the structured proposal from a transcript, a text or a photo.
 * - `summary_narrative`: the narrative of a daily summary, written from computed facts.
 */
export const AI_FEATURES = [
  'capture_transcription',
  'capture_extraction',
  'summary_narrative',
] as const;
export const aiFeatureSchema = z.enum(AI_FEATURES);
export type AiFeature = z.infer<typeof aiFeatureSchema>;

/** Longest range of `GET /ai/usage`, in days. */
export const AI_USAGE_MAX_DAYS = 92;

/**
 * `GET /ai/usage` [ai_usage.read] (admins). Days are UTC days, the unit of the usage limits.
 * Default: the last 30 days up to today (UTC). `from` and `to` are inclusive.
 */
export const aiUsageQuerySchema = z.object({
  from: dayKeySchema.optional(),
  to: dayKeySchema.optional(),
});
export type AiUsageQuery = z.infer<typeof aiUsageQuerySchema>;

const usageCountsShape = {
  /** Provider calls (every trace row, retries included). */
  requests: z.number().int().min(0),
  ok: z.number().int().min(0),
  invalidOutput: z.number().int().min(0),
  failed: z.number().int().min(0),
  timeout: z.number().int().min(0),
  /** Calls refused by a limit before reaching the provider. */
  limited: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  audioSeconds: z.number().min(0),
  /** Estimated from the code's price table, US dollars. */
  costUsd: z.number().min(0),
};

export const aiUsageRowSchema = z.object({
  /** UTC day. */
  day: dayKeySchema,
  feature: z.string(),
  provider: z.string(),
  model: z.string(),
  ...usageCountsShape,
});
export type AiUsageRow = z.infer<typeof aiUsageRowSchema>;

export const aiUsageReportSchema = z.object({
  generatedAt: isoDateTimeSchema,
  from: dayKeySchema,
  to: dayKeySchema,
  /** One row per (day, feature, provider, model) with at least one call, newest day first. */
  rows: z.array(aiUsageRowSchema),
  totals: z.object(usageCountsShape),
  /** Today (UTC) against the limits in force. */
  today: z.object({
    day: dayKeySchema,
    requests: z.number().int().min(0),
    costUsd: z.number().min(0),
  }),
  limits: z.object({
    /** The lower of the environment's ceiling and the organization's own limit. */
    dailyRequestLimit: z.number().int().min(0),
    dailyCostLimitUsd: z.number().min(0),
    /** The environment's ceilings (`AI_DAILY_LIMIT_PER_ORG`, `AI_DAILY_COST_LIMIT_USD_PER_ORG`). */
    envDailyRequestLimit: z.number().int().min(0),
    envDailyCostLimitUsd: z.number().min(0),
    rateLimitPerUserPerMinute: z.number().int().min(0),
  }),
  /** What the API is configured with now; `fake` when no key is set (ADR-0010). */
  providers: z.object({
    llm: z.object({ name: z.string(), model: z.string() }),
    speechToText: z.object({ name: z.string(), model: z.string() }),
  }),
});
export type AiUsageReport = z.infer<typeof aiUsageReportSchema>;

export function aiUsageEndpoints(transport: ApiTransport) {
  return {
    /** Admins: AI calls, tokens and estimated cost per day and feature. */
    get(query: { from?: string; to?: string } = {}): Promise<ApiResult<AiUsageReport>> {
      return transport.request({ path: '/ai/usage', query, schema: aiUsageReportSchema });
    },
  };
}
