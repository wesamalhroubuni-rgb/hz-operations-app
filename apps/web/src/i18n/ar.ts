import type { CatalogueShape } from '@ops/shared';

import { ai } from './ar/ai';
import { audit } from './ar/audit';
import { core } from './ar/core';
import { csvExport } from './ar/csv-export';
import { mapPage } from './ar/map-page';
import { overview } from './ar/overview';
import { people } from './ar/people';
import { report } from './ar/report';
import { settings } from './ar/settings';
import { structure } from './ar/structure';
import { tasks } from './ar/tasks';
import { workLogs } from './ar/work-logs';
import type { EnglishCatalogue } from './en';

// Arabic: the dashboard catalogue, one file per namespace in `ar/` (same keys as `en/`).
export const ar: CatalogueShape<EnglishCatalogue> = {
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
