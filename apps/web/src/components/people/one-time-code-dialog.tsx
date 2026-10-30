'use client';

import { useState } from 'react';

import { Warning } from '@/components/manage/parts';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { t } from '@/i18n';
import type { OneTimeCode } from '@/lib/people';

import styles from '../manage/manage.module.css';

/** The body of the dialog (props only, so it renders in tests). */
export function OneTimeCodeView({
  code,
  expires,
  onCopy,
  copyState,
}: Readonly<{
  code: OneTimeCode;
  expires: string;
  onCopy?: (value: string) => void;
  copyState?: 'copied' | 'failed' | null;
}>) {
  return (
    <div className={styles.formStack}>
      {code.code === null ? (
        <Warning>{t('people.code.notShown')}</Warning>
      ) : (
        <>
          <Warning>{t('people.code.warning')}</Warning>
          <div>
            <p className={styles.legend}>{t('people.code.code')}</p>
            <code className={styles.code}>{code.code}</code>
          </div>
          <div className={styles.row}>
            <Button variant="primary" onClick={() => onCopy?.(code.code ?? '')}>
              {t('people.code.copy')}
            </Button>
            {code.link ? (
              <Button onClick={() => onCopy?.(code.link ?? '')}>{t('people.code.copyLink')}</Button>
            ) : null}
          </div>
          {copyState ? (
            <p className={styles.muted} role="status">
              {copyState === 'copied' ? t('people.code.copied') : t('people.code.copyFailed')}
            </p>
          ) : null}
        </>
      )}
      <p className={styles.muted}>{t('people.code.expires', { date: expires })}</p>
    </div>
  );
}

/**
 * Shows an activation or reset code ONCE. The code lives only in the parent's state while this
 * dialog is open; closing it drops it. Nothing goes to the query cache, the URL or storage.
 */
export function OneTimeCodeDialog({
  code,
  expires,
  onClose,
}: Readonly<{ code: OneTimeCode; expires: string; onClose: () => void }>) {
  const [copyState, setCopyState] = useState<'copied' | 'failed' | null>(null);

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={
        code.purpose === 'activation'
          ? t('people.code.activationTitle', { name: code.userName })
          : t('people.code.resetTitle', { name: code.userName })
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          {t('people.code.done')}
        </Button>
      }
    >
      <OneTimeCodeView
        code={code}
        expires={expires}
        onCopy={(v) => void copy(v)}
        copyState={copyState}
      />
    </Modal>
  );
}
