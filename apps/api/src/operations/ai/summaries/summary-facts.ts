import { zonedDayKey, type AnomalyFlag, type DailySummaryStats } from '@ops/shared';
import { daysBetween } from '../day-column';

// What the model is told about a daily summary, and how its narrative is checked (Phase 7,
// ADR-0011 section 3, ADR-0010 section 3). Pure functions, no I/O.
//
// The facts hold only numbers computed in code, the names of sites and teams, task titles and
// people as references (`P1`, ...): never a log's text, an e-mail address, a phone number or a
// display name. The narrative must use only numbers that appear in the facts and only the people
// references given; names are put in by the code after the check.

/** Longest narrative accepted, in characters (ADR-0011). */
export const NARRATIVE_MAX_CHARACTERS = 1200;
/** At most this many sites, teams, completed tasks and anomalies go into the facts. */
export const FACTS_MAX_PLACES = 10;
export const FACTS_MAX_COMPLETED_TASKS = 10;
export const FACTS_MAX_ANOMALIES = 20;

export interface FactNames {
  sites: ReadonlyMap<string, string>;
  tasks: ReadonlyMap<string, string>;
  users: ReadonlyMap<string, string>;
}

export interface NarrativeFactsInput {
  stats: DailySummaryStats;
  /** The flags of the day the recipient may see. */
  anomalies: readonly AnomalyFlag[];
  /** Visible names of the subjects of those flags. */
  names: FactNames;
  /** Titles of visible tasks completed in the day. */
  completedTaskTitles: readonly string[];
}

export interface NarrativeFacts {
  facts: Record<string, unknown>;
  /** `P1` -> display name, for the references used in the facts. */
  people: ReadonlyMap<string, string>;
}

const placeFacts = (rows: DailySummaryStats['bySite']) =>
  rows
    .filter((row) => row.name !== null)
    .slice(0, FACTS_MAX_PLACES)
    .map((row) => ({
      name: row.name,
      logs: row.logs,
      tasksOpen: row.tasksOpen,
      tasksOverdue: row.tasksOverdue,
      tasksBlocked: row.tasksBlocked,
      tasksCompleted: row.tasksCompleted,
    }));

/** The facts of a summary for the model, with people replaced by references. */
export function buildNarrativeFacts(input: NarrativeFactsInput): NarrativeFacts {
  const { stats, names } = input;
  const people = new Map<string, string>();
  const referenceOf = new Map<string, string>();
  const personRef = (userId: string | null): string | null => {
    if (!userId) {
      return null;
    }
    const name = names.users.get(userId);
    if (!name) {
      return null;
    }
    let reference = referenceOf.get(userId);
    if (!reference) {
      reference = `P${referenceOf.size + 1}`;
      referenceOf.set(userId, reference);
      people.set(reference, name);
    }
    return reference;
  };
  const nameOf = (map: ReadonlyMap<string, string>, id: string | null) =>
    id ? (map.get(id) ?? null) : null;

  const anomalies = input.anomalies.slice(0, FACTS_MAX_ANOMALIES).map((flag) => {
    const base = { kind: flag.kind, severity: flag.severity };
    switch (flag.kind) {
      case 'no_activity_site':
        return {
          ...base,
          site: nameOf(names.sites, flag.siteId),
          openTasks: flag.params.openTasks,
          lookbackDays: flag.params.lookbackDays,
          daysSinceLastLog: flag.params.lastLogAt
            ? daysBetween(zonedDayKey(flag.params.lastLogAt, stats.timeZone), stats.day)
            : null,
        };
      case 'slow_task':
        return {
          ...base,
          task: nameOf(names.tasks, flag.taskId),
          site: nameOf(names.sites, flag.siteId),
          ageHours: flag.params.ageHours,
          medianHours: flag.params.medianHours,
          timesTheUsualDuration: flag.params.factor,
          similarTasksCompared: flag.params.sampleSize,
        };
      case 'repeated_rejections':
        return {
          ...base,
          person: personRef(flag.userId),
          rejections: flag.params.rejections,
          windowDays: flag.params.windowDays,
        };
      case 'far_location':
        return {
          ...base,
          site: nameOf(names.sites, flag.siteId),
          distanceKm: flag.params.distanceKm,
          thresholdKm: flag.params.thresholdKm,
        };
    }
  });

  return {
    facts: {
      day: stats.day,
      logs: stats.logs,
      reviewsMadeToday: stats.reviews,
      logsAwaitingReview: stats.awaitingApproval,
      tasks: stats.tasks,
      workers: stats.workers,
      sites: placeFacts(stats.bySite),
      teams: placeFacts(stats.byTeam),
      completedTasks: input.completedTaskTitles.slice(0, FACTS_MAX_COMPLETED_TASKS),
      unusualItems: { total: stats.anomalies.total, items: anomalies },
    },
    people,
  };
}

/** Arabic-Indic and Extended Arabic-Indic digits as ASCII digits. */
export function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) =>
    String((digit.codePointAt(0)! - (digit >= '۰' ? 0x06f0 : 0x0660)) % 10),
  );
}

const PERSON_REFERENCE = /\bP(\d+)\b/g;
const NUMBER = /\d+(?:[.,]\d+)?/g;

/**
 * Every number the narrative may use: the numbers in the facts, and the digit groups inside
 * their texts (the day's date parts, a site called "Block 7").
 */
export function allowedNumbers(facts: unknown): Set<number> {
  const allowed = new Set<number>();
  const visit = (value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      allowed.add(value);
    } else if (typeof value === 'string') {
      for (const match of normalizeDigits(value).matchAll(NUMBER)) {
        allowed.add(Number(match[0].replace(',', '.')));
        for (const part of match[0].split(/[.,]/)) {
          allowed.add(Number(part));
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(visit);
    }
  };
  visit(facts);
  return allowed;
}

/**
 * Why a narrative is not acceptable, or null when it is: empty, too long, a person reference
 * that the facts did not give, or a number (in digits) that is not one of the facts. The reason
 * is produced by code and goes back to the model for its one retry.
 */
export function checkNarrative(
  text: string,
  allowed: ReadonlySet<number>,
  people: ReadonlyMap<string, string>,
): string | null {
  const narrative = normalizeDigits(text).trim();
  if (narrative.length === 0) {
    return 'The narrative is empty.';
  }
  if (narrative.length > NARRATIVE_MAX_CHARACTERS) {
    return `The narrative is longer than ${NARRATIVE_MAX_CHARACTERS} characters.`;
  }
  for (const match of narrative.matchAll(PERSON_REFERENCE)) {
    if (!people.has(match[0])) {
      return `${match[0]} is not a person reference given in the facts.`;
    }
  }
  const withoutPeople = narrative.replace(PERSON_REFERENCE, ' ');
  for (const match of withoutPeople.matchAll(NUMBER)) {
    if (!allowed.has(Number(match[0].replace(',', '.')))) {
      return `The number ${match[0]} does not appear in the facts; use only numbers from the facts.`;
    }
  }
  return null;
}

/** The checked narrative with each person reference replaced by the display name. */
export function substitutePeople(text: string, people: ReadonlyMap<string, string>): string {
  return normalizeDigits(text)
    .trim()
    .replace(PERSON_REFERENCE, (reference) => people.get(reference) ?? reference);
}
