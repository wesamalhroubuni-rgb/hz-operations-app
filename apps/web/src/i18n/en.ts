// English: the source catalogue of the dashboard. Every other language copies its keys (see
// `index.ts`). Write `{{name}}` for a value filled in at run time; plural messages have `one`
// and `other` (`t('table.rows', { count })`).
//
// One file per namespace (ADR-0009), so the screens can be built in parallel without editing
// the same file:
//   en/core.ts        foundation: common, nav, shell, states, table, filters, dates, status,
//                     priority, roles, map, dialog, errors, pages.<page>.title
//   agent B: en/overview.ts, en/work-logs.ts, en/map-page.ts, en/report.ts, en/csv-export.ts
//   agent C: en/tasks.ts, en/people.ts, en/structure.ts, en/audit.ts, en/settings.ts

import { audit } from './en/audit';
import { core } from './en/core';
import { csvExport } from './en/csv-export';
import { mapPage } from './en/map-page';
import { overview } from './en/overview';
import { people } from './en/people';
import { report } from './en/report';
import { settings } from './en/settings';
import { structure } from './en/structure';
import { tasks } from './en/tasks';
import { workLogs } from './en/work-logs';

export const en = {
  ...core,
  overview,
  workLogs,
  mapPage,
  report,
  csvExport,
  tasks,
  people,
  structure,
  audit,
  settings,
} as const;

export type EnglishCatalogue = typeof en;
