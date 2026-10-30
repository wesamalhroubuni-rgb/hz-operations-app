'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useOrgTime } from '@/hooks/use-organization';
import { t } from '@/i18n';
import { apiClient } from '@/lib/api/client';
import { ApiNotConfiguredError, describeError } from '@/lib/api/errors';
import { saveTextFile } from '@/lib/download';
import { exportErrorMessage, exportFileName, type ExportKind } from '@/lib/exports';

import styles from './export-button.module.css';

/**
 * "Export CSV" for the current filters (ADR-0009): fetches `GET /exports/<kind>.csv` through the
 * API client (session, refresh on 401, typed errors), then saves the text as a file. The export
 * holds every matching row inside the caller's scope, not only the visible page; over
 * `EXPORT_MAX_ROWS` the API answers 422 `export_too_large`, shown as a sentence below the button.
 *
 * `query`: the list's filters and sort (`exportQueryOf(state)`), never page parameters.
 * Usable for tasks too (`kind="tasks"`).
 */
export function ExportCsvButton({
  kind,
  query,
}: Readonly<{ kind: ExportKind; query: Record<string, string> }>) {
  const orgTime = useOrgTime();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'done'; text: string } | null>(null);

  async function run() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (apiClient === null) {
        throw new ApiNotConfiguredError();
      }
      const result =
        kind === 'workLogs'
          ? await apiClient.exports.workLogsCsv(query)
          : await apiClient.exports.tasksCsv(query);
      if (result.ok) {
        saveTextFile(result.data, exportFileName(kind, orgTime.today()));
        setMessage({ tone: 'done', text: t('csvExport.done') });
      } else {
        setMessage({ tone: 'error', text: exportErrorMessage(result.failure) });
      }
    } catch (error) {
      setMessage({ tone: 'error', text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.wrapper}>
      <Button
        onClick={run}
        busy={busy}
        busyLabel={t('csvExport.exporting')}
        title={t('csvExport.hint')}
      >
        {t('csvExport.button')}
      </Button>
      {message ? (
        <p
          className={message.tone === 'error' ? styles.error : styles.done}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
