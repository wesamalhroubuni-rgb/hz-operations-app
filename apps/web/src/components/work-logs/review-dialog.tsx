'use client';

import { WORK_LOG_REVIEW_NOTE_MAX_LENGTH } from '@ops/shared';
import { useState } from 'react';

import { ConfirmDialog } from '@/components/ui/dialog';
import { FormField, Textarea } from '@/components/ui/form-field';
import { t } from '@/i18n';

import styles from './work-logs.module.css';

export type ReviewDecision = 'approved' | 'rejected';

/**
 * Approve or reject with a note (single log or a bulk selection). The note is required when
 * rejecting (the worker sees it as the reason) and optional when approving. The dialog stays open
 * while the request runs and shows the server's refusal (`error`) inside, so nothing is lost.
 */
export function ReviewDialog({
  decision,
  title,
  description,
  busy,
  error,
  onConfirm,
  onCancel,
}: Readonly<{
  /** Null: closed. */
  decision: ReviewDecision | null;
  title: string;
  description: string;
  busy: boolean;
  error: string | null;
  onConfirm: (note: string | undefined) => void;
  onCancel: () => void;
}>) {
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [lastDecision, setLastDecision] = useState(decision);
  // A new opening starts with an empty note.
  if (decision !== lastDecision) {
    setLastDecision(decision);
    setNote('');
    setTouched(false);
  }

  const trimmed = note.trim();
  const rejecting = decision === 'rejected';
  const missing = rejecting && trimmed === '';

  return (
    <ConfirmDialog
      open={decision !== null}
      title={title}
      description={description}
      confirmLabel={rejecting ? t('workLogs.review.reject') : t('workLogs.review.approve')}
      tone={rejecting ? 'danger' : 'primary'}
      busy={busy}
      confirmDisabled={missing}
      onConfirm={() => {
        setTouched(true);
        if (!missing) {
          onConfirm(trimmed === '' ? undefined : trimmed);
        }
      }}
      onCancel={onCancel}
    >
      <FormField
        label={t('workLogs.review.noteLabel')}
        hint={rejecting ? t('workLogs.review.noteRequired') : t('workLogs.review.noteOptional')}
        error={touched && missing ? t('workLogs.review.noteMissing') : null}
        required={rejecting}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={4}
            value={note}
            maxLength={WORK_LOG_REVIEW_NOTE_MAX_LENGTH}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => setTouched(true)}
          />
        )}
      </FormField>
      {error ? (
        <p className={`${styles.notice} ${styles.noticeDanger}`} role="alert">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
