import type { DashboardOverview, DashboardPlaceActivity, LinkedCount } from '@ops/shared';

import { t, type TranslationKey } from '@/i18n';

import { hrefWithFilter } from './list-params';

/**
 * The overview's numbers as links (ADR-0009): every number opens the list it counts, with the
 * API's own `filter` (same parameter names as the list), so the number and the list agree.
 * Pure, so tested.
 */
export const TASKS_PATH = '/tasks';
export const WORK_LOGS_LIST_PATH = '/work-logs';

export type OverviewCardKey =
  'logsToday' | 'logsAwaitingApproval' | 'tasksOpen' | 'tasksOverdue' | 'tasksBlocked';

export interface OverviewCard {
  key: OverviewCardKey;
  label: string;
  count: number;
  href: string;
  /** Draws attention (overdue, blocked, awaiting approval) when the count is above zero. */
  attention: boolean;
}

const CARDS: readonly { key: OverviewCardKey; path: string; attention: boolean }[] = [
  { key: 'logsToday', path: WORK_LOGS_LIST_PATH, attention: false },
  { key: 'logsAwaitingApproval', path: WORK_LOGS_LIST_PATH, attention: true },
  { key: 'tasksOpen', path: TASKS_PATH, attention: false },
  { key: 'tasksOverdue', path: TASKS_PATH, attention: true },
  { key: 'tasksBlocked', path: TASKS_PATH, attention: true },
];

function linkOf(path: string, linked: LinkedCount): string {
  return hrefWithFilter(path, linked.filter);
}

export function overviewCards(overview: DashboardOverview): OverviewCard[] {
  return CARDS.map(({ key, path, attention }) => ({
    key,
    label: t(`overview.cards.${key}` as TranslationKey),
    count: overview[key].count,
    href: linkOf(path, overview[key]),
    attention: attention && overview[key].count > 0,
  }));
}

export interface PlaceRow {
  key: string;
  name: string;
  logsToday: number;
  tasksOpen: number;
  logsHref: string;
  tasksHref: string;
}

/**
 * Rows of "Activity per site" / "per team". Only the row with `id: null` is "No site"; a place
 * with an id but no name (the caller cannot see it by itself) is named `unknownLabel`.
 */
export function placeRows(
  places: readonly DashboardPlaceActivity[],
  noneLabel: string,
  unknownLabel: string = t('overview.activity.unknownPlace'),
): PlaceRow[] {
  return places.map((place) => ({
    key: place.id ?? 'none',
    name: place.id === null ? noneLabel : (place.name ?? unknownLabel),
    logsToday: place.logsToday,
    tasksOpen: place.tasksOpen,
    logsHref: hrefWithFilter(WORK_LOGS_LIST_PATH, place.logsFilter),
    tasksHref: hrefWithFilter(TASKS_PATH, place.tasksFilter),
  }));
}
