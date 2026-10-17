import type { WorkLog } from '@ops/shared';
import { useState } from 'react';

import { useRepositories } from '../data/DataProvider';
import type { WriteError } from '../data/results';

/** Sends a log (back) for review: a rejected log is resubmitted, a draft submitted. */
export function useLogStatusChange(log: WorkLog | undefined) {
  const repositories = useRepositories();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<WriteError | null>(null);
  const [done, setDone] = useState<'resubmitted' | 'submitted' | null>(null);

  async function submit(): Promise<void> {
    if (!log || busy) return;
    const from = log.status;
    setBusy(true);
    setError(null);
    const result = await repositories.workLogs.changeStatus(log.id, { status: 'submitted' });
    setBusy(false);
    if (result.ok) {
      setDone(from === 'rejected' ? 'resubmitted' : 'submitted');
    } else {
      setError(result.error);
    }
  }

  return { busy, error, done, submit };
}
