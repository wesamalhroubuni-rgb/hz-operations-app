import {
  ANOMALY_THRESHOLDS,
  type AnomalyKind,
  type AnomalyParams,
  type AnomalySeverity,
} from '@ops/shared';

// The anomaly rules v1 (Phase 7, ADR-0011 section 4) as pure functions over pre-loaded facts:
// no I/O, no clock. `AnomaliesService` loads the facts of one organization and day and stores
// what these return. Every flag carries the numbers behind it (`params`), and the thresholds are
// the constants of `ANOMALY_THRESHOLDS`. Suggestions only: nothing is ever done automatically.

export interface AnomalySubjects {
  siteId?: string | null;
  teamId?: string | null;
  userId?: string | null;
  taskId?: string | null;
  workLogId?: string | null;
  logTypeId?: string | null;
}

export type CandidateFlag = {
  [Kind in AnomalyKind]: {
    kind: Kind;
    severity: AnomalySeverity;
    subjects: AnomalySubjects;
    params: AnomalyParams<Kind>;
  };
}[AnomalyKind];

const HOUR_MS = 3_600_000;

/** One decimal place (hours, factors). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Two decimal places (kilometres). */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The median of a list (the mean of the two middle values for an even length); null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

const EARTH_RADIUS_KM = 6371.0088;

/** Great-circle distance between two points, in kilometres. */
export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The idempotency key of a flag: kind, day and every subject (unset ones as `-`), so the same
 * finding on the same day is stored once however often the computation runs.
 */
export function fingerprintOf(kind: AnomalyKind, day: string, subjects: AnomalySubjects): string {
  const part = (value: string | null | undefined) => value ?? '-';
  return [
    kind,
    day,
    `site=${part(subjects.siteId)}`,
    `team=${part(subjects.teamId)}`,
    `user=${part(subjects.userId)}`,
    `task=${part(subjects.taskId)}`,
    `log=${part(subjects.workLogId)}`,
    `type=${part(subjects.logTypeId)}`,
  ].join('|');
}

// ---------------------------------------------------------------------------------------------
// no_activity_site
// ---------------------------------------------------------------------------------------------

export interface SiteActivityFacts {
  siteId: string;
  /** Open (todo, in progress, blocked), non-archived tasks at the site now. */
  openTasks: number;
  /** Of those, the ones whose due time is before the end of the day. */
  overdueOpenTasks: number;
  /** Non-archived logs at the site in the lookback window (the day included). */
  logsInLookback: number;
  /** Non-archived logs at the site whose `occurredAt` is in the day. */
  logsOnDay: number;
  /** The site's latest non-archived log before the day, or null. */
  lastLogBeforeDay: Date | null;
}

/**
 * A non-archived site that is active (an open task there, or a log there in the last
 * `activeSiteLookbackDays` days) without a log on the day. `high` with an overdue open task.
 */
export function noActivitySiteFlags(sites: readonly SiteActivityFacts[]): CandidateFlag[] {
  const flags: CandidateFlag[] = [];
  for (const site of sites) {
    const active = site.openTasks > 0 || site.logsInLookback > 0;
    if (!active || site.logsOnDay > 0) {
      continue;
    }
    flags.push({
      kind: 'no_activity_site',
      severity: site.overdueOpenTasks > 0 ? 'high' : 'medium',
      subjects: { siteId: site.siteId },
      params: {
        lookbackDays: ANOMALY_THRESHOLDS.activeSiteLookbackDays,
        lastLogAt: site.lastLogBeforeDay ? site.lastLogBeforeDay.toISOString() : null,
        openTasks: site.openTasks,
      },
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// slow_task
// ---------------------------------------------------------------------------------------------

export interface OpenTaskFacts {
  taskId: string;
  siteId: string | null;
  createdAt: Date;
  /** The log type most of the task's logs have, or null (no typed log). */
  dominantLogTypeId: string | null;
}

export interface CompletedTaskFacts {
  siteId: string | null;
  createdAt: Date;
  completedAt: Date;
  dominantLogTypeId: string | null;
}

/**
 * The log type that most of a task's logs have; ties go to the smallest id (deterministic).
 * Null when no log has a type.
 */
export function dominantLogType(logTypeIds: readonly (string | null)[]): string | null {
  const counts = new Map<string, number>();
  for (const id of logTypeIds) {
    if (id) {
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && id < best)) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/**
 * An open task older than `slowTaskFactor` x the median duration (created to completed) of the
 * tasks completed recently in its group: same site and same dominant log type, or the site alone
 * when that sample is smaller than `slowTaskMinSample`; no flag below that sample or for a task
 * without a site. `high` over twice the factor. `completed` must already be limited to the
 * lookback window; `asOf` is the moment the age is measured at.
 */
export function slowTaskFlags(
  openTasks: readonly OpenTaskFacts[],
  completed: readonly CompletedTaskFacts[],
  asOf: Date,
): CandidateFlag[] {
  const { slowTaskFactor, slowTaskMinSample } = ANOMALY_THRESHOLDS;
  const durationHours = (task: CompletedTaskFacts) =>
    Math.max(0, task.completedAt.getTime() - task.createdAt.getTime()) / HOUR_MS;
  const flags: CandidateFlag[] = [];
  for (const task of openTasks) {
    if (!task.siteId) {
      continue;
    }
    const atSite = completed.filter((done) => done.siteId === task.siteId);
    const sameType =
      task.dominantLogTypeId === null
        ? []
        : atSite.filter((done) => done.dominantLogTypeId === task.dominantLogTypeId);
    const useType = sameType.length >= slowTaskMinSample;
    const sample = useType ? sameType : atSite;
    if (sample.length < slowTaskMinSample) {
      continue;
    }
    const medianHours = median(sample.map(durationHours));
    if (medianHours === null || medianHours <= 0) {
      continue;
    }
    const ageHours = Math.max(0, asOf.getTime() - task.createdAt.getTime()) / HOUR_MS;
    const factor = ageHours / medianHours;
    if (factor <= slowTaskFactor) {
      continue;
    }
    flags.push({
      kind: 'slow_task',
      severity: factor > 2 * slowTaskFactor ? 'high' : 'medium',
      subjects: {
        taskId: task.taskId,
        siteId: task.siteId,
        ...(useType ? { logTypeId: task.dominantLogTypeId } : {}),
      },
      params: {
        ageHours: round1(ageHours),
        medianHours: round1(medianHours),
        factor: round1(factor),
        sampleSize: sample.length,
        group: useType ? 'site_log_type' : 'site',
      },
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// repeated_rejections
// ---------------------------------------------------------------------------------------------

/**
 * A worker with at least `repeatedRejectionsCount` rejections of their logs in the window
 * (one entry per rejection, already limited to the window). `high` at 5 or more.
 */
export function repeatedRejectionFlags(rejectedAuthorIds: readonly string[]): CandidateFlag[] {
  const { repeatedRejectionsCount, repeatedRejectionsWindowDays } = ANOMALY_THRESHOLDS;
  const counts = new Map<string, number>();
  for (const authorId of rejectedAuthorIds) {
    counts.set(authorId, (counts.get(authorId) ?? 0) + 1);
  }
  const flags: CandidateFlag[] = [];
  for (const [userId, rejections] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    if (rejections < repeatedRejectionsCount) {
      continue;
    }
    flags.push({
      kind: 'repeated_rejections',
      severity: rejections >= 5 ? 'high' : 'medium',
      subjects: { userId },
      params: { rejections, windowDays: repeatedRejectionsWindowDays },
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// far_location
// ---------------------------------------------------------------------------------------------

export interface Point {
  latitude: number;
  longitude: number;
}

export interface SiteReference extends Point {
  reference: 'site_coordinates' | 'median_of_logs';
  /** Logs behind a median; null for the site's own coordinates. */
  sampleSize: number | null;
}

/**
 * Where a site is: its own coordinates when both are set, else the median (per coordinate) of
 * its located logs of the lookback window, when there are at least `farLocationMinSample`.
 */
export function siteReference(
  site: { latitude: number | null; longitude: number | null },
  locatedLogs: readonly Point[],
): SiteReference | null {
  if (site.latitude !== null && site.longitude !== null) {
    return {
      latitude: site.latitude,
      longitude: site.longitude,
      reference: 'site_coordinates',
      sampleSize: null,
    };
  }
  if (locatedLogs.length < ANOMALY_THRESHOLDS.farLocationMinSample) {
    return null;
  }
  return {
    latitude: median(locatedLogs.map((log) => log.latitude))!,
    longitude: median(locatedLogs.map((log) => log.longitude))!,
    reference: 'median_of_logs',
    sampleSize: locatedLogs.length,
  };
}

export interface LocatedLogFacts extends Point {
  workLogId: string;
  siteId: string;
}

/**
 * A log of the day more than `farLocationKm` from its site's reference point. `medium` over
 * 10 km, else `low`. Logs of a site without a reference are skipped.
 */
export function farLocationFlags(
  logs: readonly LocatedLogFacts[],
  references: ReadonlyMap<string, SiteReference>,
): CandidateFlag[] {
  const { farLocationKm } = ANOMALY_THRESHOLDS;
  const flags: CandidateFlag[] = [];
  for (const log of logs) {
    const reference = references.get(log.siteId);
    if (!reference) {
      continue;
    }
    const distanceKm = haversineKm(log, reference);
    if (distanceKm <= farLocationKm) {
      continue;
    }
    flags.push({
      kind: 'far_location',
      severity: distanceKm > 10 ? 'medium' : 'low',
      subjects: { workLogId: log.workLogId, siteId: log.siteId },
      params: {
        distanceKm: round2(distanceKm),
        thresholdKm: farLocationKm,
        reference: reference.reference,
        sampleSize: reference.sampleSize,
      },
    });
  }
  return flags;
}
