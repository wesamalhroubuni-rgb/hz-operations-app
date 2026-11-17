import type { CatalogueShape } from '@ops/shared';

import { ai } from './tr/ai';
import { audit } from './tr/audit';
import { core } from './tr/core';
import { csvExport } from './tr/csv-export';
import { mapPage } from './tr/map-page';
import { overview } from './tr/overview';
import { people } from './tr/people';
import { report } from './tr/report';
import { settings } from './tr/settings';
import { structure } from './tr/structure';
import { tasks } from './tr/tasks';
import { workLogs } from './tr/work-logs';
import type { EnglishCatalogue } from './en';

// Turkish: the dashboard catalogue, one file per namespace in `tr/` (same keys as `en/`).
export const tr: CatalogueShape<EnglishCatalogue> = {
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
  ai,
};
