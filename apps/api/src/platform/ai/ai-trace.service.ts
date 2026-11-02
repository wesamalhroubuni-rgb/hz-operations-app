import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AiDecision, AiTraceStatus, AiUsageReader, AiUsageRow, PromptRef } from './ai-types';

/** One row of `AiTrace`, as the runner writes it. */
export interface AiTraceInput {
  organizationId: string;
  feature: string;
  provider: string;
  model: string;
  prompt: PromptRef | null;
  attempt: number;
  inputRefs: Readonly<Record<string, unknown>>;
  /** The parsed output (the transcript for speech-to-text); null when not ok. */
  output: unknown;
  status: AiTraceStatus;
  errorCode: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  audioSeconds: number | null;
  costUsd: number | null;
  requestedById: string | null;
  correlationId: string | null;
  createdAt: Date;
}

const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of an instant, in UTC (the day of the usage limits). */
export function utcDayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The first instant of a UTC day key. */
export function utcDayStart(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

interface UsageQueryRow {
  day: string;
  feature: string;
  provider: string;
  model: string;
  requests: bigint | number;
  ok: bigint | number;
  invalid_output: bigint | number;
  failed: bigint | number;
  timeout: bigint | number;
  limited: bigint | number;
  input_tokens: bigint | number;
  output_tokens: bigint | number;
  audio_seconds: number | string;
  cost_usd: number | string;
}

/**
 * The `AiTrace` table (reusable platform component, ADR-0010): one row per provider call or
 * limit refusal, the usage report and the counts behind the daily limits. Rows are written
 * outside any business transaction (a trace stays even when the caller's work rolls back).
 */
@Injectable()
export class AiTraceService implements AiUsageReader {
  constructor(private readonly prisma: PrismaService) {}

  async record(trace: AiTraceInput): Promise<string> {
    const row = await this.prisma.aiTrace.create({
      data: {
        organizationId: trace.organizationId,
        feature: trace.feature,
        provider: trace.provider,
        model: trace.model,
        promptId: trace.prompt?.id ?? null,
        promptVersion: trace.prompt?.version ?? null,
        attempt: trace.attempt,
        inputRefs: trace.inputRefs as Prisma.InputJsonObject,
        ...(trace.output === null || trace.output === undefined
          ? {}
          : { output: trace.output as Prisma.InputJsonValue }),
        status: trace.status,
        errorCode: trace.errorCode,
        latencyMs: trace.latencyMs,
        inputTokens: trace.inputTokens,
        outputTokens: trace.outputTokens,
        audioSeconds: trace.audioSeconds,
        costEstimateUsd: trace.costUsd,
        requestedById: trace.requestedById,
        correlationId: trace.correlationId,
        createdAt: trace.createdAt,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Stamps a decision on traces that have none yet (idempotent: the first decision stays). */
  async decide(
    traceIds: readonly string[],
    decision: AiDecision,
    decidedById: string,
    decidedAt: Date,
  ): Promise<void> {
    if (traceIds.length === 0) {
      return;
    }
    await this.prisma.aiTrace.updateMany({
      where: { id: { in: [...traceIds] }, decision: null },
      data: { decision, decidedById, decidedAt },
    });
  }

  async today(organizationId: string, now: Date): Promise<{ requests: number; costUsd: number }> {
    const start = utcDayStart(utcDayKey(now));
    const result = await this.prisma.aiTrace.aggregate({
      where: {
        organizationId,
        status: { not: 'limited' },
        createdAt: { gte: start, lt: new Date(start.getTime() + DAY_MS) },
      },
      _count: { _all: true },
      _sum: { costEstimateUsd: true },
    });
    return {
      requests: result._count._all,
      costUsd: Number(result._sum.costEstimateUsd ?? 0),
    };
  }

  async usage(organizationId: string, fromDay: string, toDay: string): Promise<AiUsageRow[]> {
    const from = utcDayStart(fromDay);
    const to = new Date(utcDayStart(toDay).getTime() + DAY_MS);
    const rows = await this.prisma.$queryRaw<UsageQueryRow[]>`
      SELECT
        to_char(("createdAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day,
        "feature" AS feature,
        "provider" AS provider,
        "model" AS model,
        count(*) AS requests,
        count(*) FILTER (WHERE "status" = 'ok') AS ok,
        count(*) FILTER (WHERE "status" = 'invalid_output') AS invalid_output,
        count(*) FILTER (WHERE "status" = 'failed') AS failed,
        count(*) FILTER (WHERE "status" = 'timeout') AS timeout,
        count(*) FILTER (WHERE "status" = 'limited') AS limited,
        coalesce(sum("inputTokens"), 0)::bigint AS input_tokens,
        coalesce(sum("outputTokens"), 0)::bigint AS output_tokens,
        coalesce(sum("audioSeconds"), 0)::float8 AS audio_seconds,
        coalesce(sum("costEstimateUsd"), 0)::float8 AS cost_usd
      FROM "AiTrace"
      WHERE "organizationId" = ${organizationId}::uuid
        AND "createdAt" >= ${from}
        AND "createdAt" < ${to}
      GROUP BY 1, 2, 3, 4
      ORDER BY 1 DESC, 2, 3, 4`;
    return rows.map((row) => ({
      day: row.day,
      feature: row.feature,
      provider: row.provider,
      model: row.model,
      requests: Number(row.requests),
      ok: Number(row.ok),
      invalidOutput: Number(row.invalid_output),
      failed: Number(row.failed),
      timeout: Number(row.timeout),
      limited: Number(row.limited),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      audioSeconds: Number(row.audio_seconds),
      costUsd: Math.round(Number(row.cost_usd) * 1_000_000) / 1_000_000,
    }));
  }

  /**
   * Retention (ADR-0010 section 3): clears `output` of traces older than 90 days and deletes
   * traces older than 400 days. For the host's scheduled clean-up; returns the counts.
   */
  async purgeExpired(now: Date): Promise<{ outputsCleared: number; deleted: number }> {
    const outputsBefore = new Date(now.getTime() - 90 * DAY_MS);
    const rowsBefore = new Date(now.getTime() - 400 * DAY_MS);
    const deleted = await this.prisma.aiTrace.deleteMany({
      where: { createdAt: { lt: rowsBefore } },
    });
    const cleared = await this.prisma.$executeRaw`
      UPDATE "AiTrace" SET "output" = NULL
      WHERE "createdAt" < ${outputsBefore} AND "output" IS NOT NULL`;
    return { outputsCleared: cleared, deleted: deleted.count };
  }
}
