import { z } from 'zod';

// Per-organization switches and limits of the intelligent layer (Phase 7, ADR-0010, ADR-0011).
// Stored under `settings.ai` of the organization and edited by admins through
// `PATCH /organization` (the settings object is replaced as a whole). Every feature is OFF until
// an admin turns it on. The environment's limits (`AI_DAILY_LIMIT_PER_ORG`,
// `AI_DAILY_COST_LIMIT_USD_PER_ORG`) are the hard ceiling: an organization's limit can only make
// them lower.

/** Roles that can receive a daily summary. Workers never do. */
export const AI_SUMMARY_RECIPIENT_ROLES = ['supervisor', 'manager', 'admin'] as const;
export const aiSummaryRecipientRoleSchema = z.enum(AI_SUMMARY_RECIPIENT_ROLES);
export type AiSummaryRecipientRole = z.infer<typeof aiSummaryRecipientRoleSchema>;

export const DEFAULT_AI_SUMMARY_TIME = '18:00';
export const DEFAULT_AI_SUMMARY_RECIPIENT_ROLES: readonly AiSummaryRecipientRole[] = [
  'supervisor',
  'manager',
];

/** Largest per-organization daily request limit an admin can store. */
export const MAX_AI_DAILY_REQUEST_LIMIT = 100_000;
/** Largest per-organization daily cost limit an admin can store, in US dollars. */
export const MAX_AI_DAILY_COST_LIMIT_USD = 10_000;

/** A time of day `HH:MM` (24-hour), in the organization's time zone. */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'must be a time of day as HH:MM (24-hour)' });

export const organizationAiSettingsSchema = z.strictObject({
  /** "Speak" and "Snap" on the phone, and `POST /ai/capture`. Default false. */
  smartCaptureEnabled: z.boolean().optional(),
  /** The scheduled daily summaries and anomaly flags. Default false. */
  dailySummaryEnabled: z.boolean().optional(),
  /** When the daily summary is generated, in the organization's time zone. Default 18:00. */
  summaryTime: timeOfDaySchema.optional(),
  /** Who receives a summary, by role (any active membership with one of them). */
  summaryRecipientRoles: z
    .array(aiSummaryRecipientRoleSchema)
    .max(AI_SUMMARY_RECIPIENT_ROLES.length)
    .refine((roles) => new Set(roles).size === roles.length, { error: 'must not repeat a role' })
    .optional(),
  /** AI requests per UTC day for the organization; absent = the environment's limit. */
  dailyRequestLimit: z.number().int().min(0).max(MAX_AI_DAILY_REQUEST_LIMIT).optional(),
  /** Estimated AI cost per UTC day, US dollars; absent = the environment's limit. */
  dailyCostLimitUsd: z.number().min(0).max(MAX_AI_DAILY_COST_LIMIT_USD).optional(),
});
export type OrganizationAiSettings = z.infer<typeof organizationAiSettingsSchema>;

/** The AI settings in force, with every default applied. */
export interface ResolvedAiSettings {
  smartCaptureEnabled: boolean;
  dailySummaryEnabled: boolean;
  summaryTime: string;
  summaryRecipientRoles: AiSummaryRecipientRole[];
  /** Null: no organization limit (the environment's ceiling applies). */
  dailyRequestLimit: number | null;
  dailyCostLimitUsd: number | null;
}

/**
 * The AI settings of an organization's stored `settings`, with defaults for anything absent or
 * unusable (settings written before Phase 7, a hand-edited row). Never throws.
 */
export function aiSettingsOf(settings: unknown): ResolvedAiSettings {
  const raw =
    typeof settings === 'object' && settings !== null
      ? (settings as Record<string, unknown>).ai
      : undefined;
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const pick = <Schema extends z.ZodType>(schema: Schema, value: unknown) => {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as z.infer<Schema>) : undefined;
  };
  const shape = organizationAiSettingsSchema.shape;
  return {
    smartCaptureEnabled: pick(shape.smartCaptureEnabled, source.smartCaptureEnabled) ?? false,
    dailySummaryEnabled: pick(shape.dailySummaryEnabled, source.dailySummaryEnabled) ?? false,
    summaryTime: pick(shape.summaryTime, source.summaryTime) ?? DEFAULT_AI_SUMMARY_TIME,
    summaryRecipientRoles: pick(shape.summaryRecipientRoles, source.summaryRecipientRoles) ?? [
      ...DEFAULT_AI_SUMMARY_RECIPIENT_ROLES,
    ],
    dailyRequestLimit: pick(shape.dailyRequestLimit, source.dailyRequestLimit) ?? null,
    dailyCostLimitUsd: pick(shape.dailyCostLimitUsd, source.dailyCostLimitUsd) ?? null,
  };
}

/**
 * The limit in force: the lower of the environment's ceiling and the organization's own limit
 * (null when the organization has none).
 */
export function effectiveAiLimit(envCeiling: number, organizationLimit: number | null): number {
  return organizationLimit === null ? envCeiling : Math.min(envCeiling, organizationLimit);
}

/**
 * What every signed-in user learns about the AI features (in the organization summary), so the
 * phone shows "Speak" and "Snap" only when smart capture is on. Absent in answers of an API
 * older than Phase 7: treat as both off ({@link aiFeaturesOf}).
 */
export const organizationAiFeaturesSchema = z.object({
  smartCapture: z.boolean(),
  dailySummary: z.boolean(),
});
export type OrganizationAiFeatures = z.infer<typeof organizationAiFeaturesSchema>;

export function aiFeaturesOf(summary: { aiFeatures?: OrganizationAiFeatures | undefined } | null) {
  return summary?.aiFeatures ?? { smartCapture: false, dailySummary: false };
}
