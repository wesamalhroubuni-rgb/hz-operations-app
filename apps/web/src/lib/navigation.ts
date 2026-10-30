import type { TranslationKey } from '@/i18n';

import type { Capabilities, PageCapability } from './permissions';

/**
 * The dashboard's routes, their navigation entries and the capability each needs (UX only:
 * the API authorises every request). The left navigation, the route check of the app shell and
 * the placeholder pages all read this list.
 *
 * Page ownership in Phase 6 (ADR-0009): agent B owns overview, work logs (list, detail,
 * report) and map; agent C owns tasks, people, structure, audit and settings.
 */
export interface NavItem {
  key: 'overview' | 'workLogs' | 'tasks' | 'map' | 'people' | 'structure' | 'audit' | 'settings';
  href: string;
  label: TranslationKey;
  /** The capability that shows the entry and opens the page. */
  requires: PageCapability;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { key: 'overview', href: '/', label: 'nav.overview', requires: 'viewOverview' },
  { key: 'workLogs', href: '/work-logs', label: 'nav.workLogs', requires: 'usesDashboard' },
  { key: 'tasks', href: '/tasks', label: 'nav.tasks', requires: 'usesDashboard' },
  { key: 'map', href: '/map', label: 'nav.map', requires: 'viewOverview' },
  { key: 'people', href: '/people', label: 'nav.people', requires: 'viewPeople' },
  { key: 'structure', href: '/structure', label: 'nav.structure', requires: 'viewStructure' },
  { key: 'audit', href: '/audit', label: 'nav.audit', requires: 'readAudit' },
  { key: 'settings', href: '/settings', label: 'nav.settings', requires: 'editSettings' },
];

export function visibleNavItems(capabilities: Capabilities): NavItem[] {
  return NAV_ITEMS.filter((item) => capabilities[item.requires]);
}

function normalise(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** The navigation entry a path belongs to (`/work-logs/123` is under Work logs), or null. */
export function navItemFor(pathname: string): NavItem | null {
  const path = normalise(pathname);
  let best: NavItem | null = null;
  for (const item of NAV_ITEMS) {
    const matches =
      item.href === '/' ? path === '/' : path === item.href || path.startsWith(`${item.href}/`);
    if (matches && (best === null || item.href.length > best.href.length)) {
      best = item;
    }
  }
  return best;
}

export type RouteAccess = 'allowed' | 'not-for-role' | 'worker' | 'no-role';

/**
 * Whether the shell shows a page or a "not available" state. Workers and users without a role
 * get their own message, since no page of the dashboard is for them. A path that is not in the
 * navigation (a future page) needs only `usesDashboard`.
 */
export function routeAccess(pathname: string, capabilities: Capabilities): RouteAccess {
  if (capabilities.role === null) {
    return 'no-role';
  }
  if (!capabilities.usesDashboard) {
    return 'worker';
  }
  const item = navItemFor(pathname);
  return item === null || capabilities[item.requires] ? 'allowed' : 'not-for-role';
}

/** Where a dashboard user lands: the first page their role may open. */
export function homeFor(capabilities: Capabilities): string {
  return visibleNavItems(capabilities)[0]?.href ?? '/';
}
