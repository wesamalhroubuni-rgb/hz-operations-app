import { TASK_STATUS_REASON_MAX_LENGTH, type Task, type TaskStatus } from '@ops/shared';
import { useState } from 'react';

import { useRepositories } from '../data/DataProvider';
import type { WriteError } from '../data/results';
import { statusNeedsReason } from '../logic/tasks';

/**
 * A status change of one task, through the tasks repository. `blocked` first asks for the
 * reason; the change is sent when the reason is confirmed. The typed reason is kept after a
 * failure so it can be sent again.
 */
export function useTaskStatusChange(task: Task | undefined) {
  const repositories = useRepositories();
  const [askingReason, setAskingReason] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonMissing, setReasonMissing] = useState(false);
  const [busy, setBusy] = useState<TaskStatus | null>(null);
  const [error, setError] = useState<WriteError | null>(null);
  const [changedTo, setChangedTo] = useState<TaskStatus | null>(null);

  async function send(status: TaskStatus, why?: string): Promise<void> {
    if (!task || busy !== null) return;
    setBusy(status);
    setError(null);
    setChangedTo(null);
    const result = await repositories.tasks.changeStatus(
      task.id,
      why ? { status, reason: why } : { status },
    );
    setBusy(null);
    if (result.ok) {
      setChangedTo(status);
      setAskingReason(false);
      setReason('');
    } else {
      setError(result.error);
    }
  }

  function choose(status: TaskStatus): void {
    if (statusNeedsReason(status)) {
      setAskingReason(true);
      setReasonMissing(false);
      setError(null);
      return;
    }
    void send(status);
  }

  function confirmReason(): void {
    const trimmed = reason.trim();
    if (trimmed === '') {
      setReasonMissing(true);
      return;
    }
    setReasonMissing(false);
    void send('blocked', trimmed.slice(0, TASK_STATUS_REASON_MAX_LENGTH));
  }

  function cancelReason(): void {
    setAskingReason(false);
    setReasonMissing(false);
  }

  return {
    askingReason,
    reason,
    setReason,
    reasonMissing,
    busy,
    error,
    changedTo,
    choose,
    confirmReason,
    cancelReason,
  };
}
