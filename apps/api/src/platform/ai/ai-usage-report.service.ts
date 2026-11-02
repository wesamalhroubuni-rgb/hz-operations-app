import { Inject, Injectable } from '@nestjs/common';
import { AI_USAGE_MAX_DAYS, type AiUsageReport } from '@ops/shared';
import { ApiException } from '../http/api-exception';
import { AI_SETTINGS, type AiSettings } from './ai-settings';
import { AiTraceService, utcDayKey, utcDayStart } from './ai-trace.service';
import { AI_RUNNER, type AiRunner } from './ai-types';
import { AiUsageLimiter } from './usage-limiter';

/** Days of the report when the caller names none: the last 30 UTC days, today included. */
export const DEFAULT_AI_USAGE_DAYS = 30;

const DAY_MS = 86_400_000;

function shiftDay(day: string, days: number): string {
  return utcDayKey(new Date(utcDayStart(day).getTime() + days * DAY_MS));
}

function daysBetween(from: string, to: string): number {
  return Math.round((utcDayStart(to).getTime() - utcDayStart(from).getTime()) / DAY_MS) + 1;
}

/**
 * The AI usage report of one organization (`GET /ai/usage`, ADR-0010 section 7): calls,
 * outcomes, tokens, audio and estimated cost per UTC day, feature, provider and model; today
 * against the limits in force; the providers configured now.
 */
@Injectable()
export class AiUsageReportService {
  constructor(
    @Inject(AI_SETTINGS) private readonly settings: AiSettings,
    @Inject(AI_RUNNER) private readonly runner: AiRunner,
    private readonly traces: AiTraceService,
    private readonly limiter: AiUsageLimiter,
  ) {}

  /**
   * Resolves the range: both ends default (to today, from 29 days before `to`); `from` after
   * `to` or a range longer than {@link AI_USAGE_MAX_DAYS} is a 400.
   */
  rangeOf(query: { from?: string; to?: string }, now: Date): { from: string; to: string } {
    const to = query.to ?? utcDayKey(now);
    const from = query.from ?? shiftDay(to, -(DEFAULT_AI_USAGE_DAYS - 1));
    if (from > to) {
      throw ApiException.validation([{ path: 'from', message: 'must not be after to' }]);
    }
    if (daysBetween(from, to) > AI_USAGE_MAX_DAYS) {
      throw ApiException.validation([
        { path: 'from', message: `the range must be at most ${AI_USAGE_MAX_DAYS} days` },
      ]);
    }
    return { from, to };
  }

  async report(
    organizationId: string,
    query: { from?: string; to?: string },
    now: Date,
  ): Promise<AiUsageReport> {
    const { from, to } = this.rangeOf(query, now);
    const [rows, today, limits] = await Promise.all([
      this.traces.usage(organizationId, from, to),
      this.traces.today(organizationId, now),
      this.limiter.limitsFor(organizationId),
    ]);
    const totals = {
      requests: 0,
      ok: 0,
      invalidOutput: 0,
      failed: 0,
      timeout: 0,
      limited: 0,
      inputTokens: 0,
      outputTokens: 0,
      audioSeconds: 0,
      costUsd: 0,
    };
    for (const row of rows) {
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[key] += row[key];
      }
    }
    totals.costUsd = Math.round(totals.costUsd * 1_000_000) / 1_000_000;
    totals.audioSeconds = Math.round(totals.audioSeconds * 1000) / 1000;
    const providers = this.runner.providers();
    return {
      generatedAt: now.toISOString(),
      from,
      to,
      rows,
      totals,
      today: {
        day: utcDayKey(now),
        requests: today.requests,
        costUsd: Math.round(today.costUsd * 1_000_000) / 1_000_000,
      },
      limits,
      providers: {
        llm: providers.llm
          ? { name: providers.llm.name, model: providers.llm.model }
          : { name: 'unavailable', model: this.settings.llmModel },
        speechToText: providers.speechToText
          ? { name: providers.speechToText.name, model: providers.speechToText.model }
          : { name: 'unavailable', model: this.settings.sttModel },
      },
    };
  }
}
