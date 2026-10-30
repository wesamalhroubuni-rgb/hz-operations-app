'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

import { t } from '@/i18n';

import { Button } from './button';
import styles from './dialog.module.css';

export interface ModalProps {
  open: boolean;
  /** Called on Escape, the close button, and a click on the backdrop. */
  onClose: () => void;
  title: string;
  children: ReactNode;
  /** Buttons at the bottom (end-aligned). */
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** `drawer`: a full-height panel on the inline-end side. */
  variant?: 'modal' | 'drawer';
}

/**
 * A modal dialog on the native `<dialog>` element: focus moves into it and stays there, Escape
 * closes it, focus returns to the opener afterwards, and the rest of the page is inert.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  variant = 'modal',
}: Readonly<ModalProps>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  const className = [
    styles.dialog,
    variant === 'drawer'
      ? styles.drawer
      : size === 'sm'
        ? styles.sm
        : size === 'lg'
          ? styles.lg
          : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={titleId}
      onCancel={(event) => {
        // Escape: let React state decide, so `open` stays the single source of truth.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          onClose();
        }
      }}
    >
      {open ? (
        <div className={styles.inner}>
          <header className={styles.header}>
            <h2 id={titleId} className={styles.title}>
              {title}
            </h2>
            <Button variant="ghost" size="sm" onClick={onClose} aria-label={t('dialog.close')}>
              ×
            </Button>
          </header>
          <div className={styles.body}>{children}</div>
          {footer ? <footer className={styles.footer}>{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** A side panel (details, an edit form) over the page. Same behaviour as `Modal`. */
export function Drawer(props: Readonly<Omit<ModalProps, 'variant' | 'size'>>) {
  return <Modal {...props} variant="drawer" />;
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel: string;
  /** `danger` for archive, reject, revoke. */
  tone?: 'primary' | 'danger';
  /** The action is running: buttons disabled, the dialog stays open. */
  busy?: boolean;
  /** Extra content, e.g. the note field of a rejection, or the error of a failed attempt. */
  children?: ReactNode;
  /** Disables confirm (e.g. a required note is empty). */
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/** "Are you sure?" with Cancel and a confirm button. Cancel is focused first (safe default). */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  tone = 'primary',
  busy = false,
  children,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: Readonly<ConfirmDialogProps>) {
  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy} autoFocus>
            {t('common.cancel')}
          </Button>
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={onConfirm}
            busy={busy}
            disabled={confirmDisabled}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {description ? <p className={styles.description}>{description}</p> : null}
      {children}
    </Modal>
  );
}
