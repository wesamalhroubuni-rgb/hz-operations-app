import { EXPORT_MAX_ROWS, type ApiFailure } from '@ops/shared';

import { formatNumber, t } from '@/i18n';
import { describeError, ApiCallError } from '@/lib/api/errors';

/**
 * CSV export helpers (ADR-0009). The export itself is fetched through `apiClient.exports.*` and
 * saved with `saveTextFile`; these turn its failures into a sentence and name the file. Pure,
 * so tested.
 */
export type ExportKind = 'workLogs' | 'tasks';

const FILE_PREFIX: Record<ExportKind, string> = {
  workLogs: 'work-logs',
  tasks: 'tasks',
};

/** `work-logs-2026-10-28.csv`: the day is today in the organization's zone. */
export function exportFileName(kind: ExportKind, day: string): string {
  return `${FILE_PREFIX[kind]}-${day}.csv`;
}

/**
 * The message of a failed export: `export_too_large` (422) explains the row cap and how to get
 * under it; 403 says the role cannot export; anything else uses the generic error sentence.
 */
export function exportErrorMessage(failure: ApiFailure): string {
  if (failure.kind === 'http') {
    if (failure.error.code === 'export_too_large') {
      return t('csvExport.tooLarge', { max: formatNumber(EXPORT_MAX_ROWS) });
    }
    if (failure.status === 403) {
      return t('csvExport.forbidden');
    }
  }
  return t('csvExport.failed', { reason: describeError(new ApiCallError(failure)) });
}
