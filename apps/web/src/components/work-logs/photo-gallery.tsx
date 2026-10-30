'use client';

import type { Attachment } from '@ops/shared';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/dialog';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { DIRECTION, t } from '@/i18n';
import {
  afterPhotoError,
  afterPhotoLoad,
  INITIAL_PHOTO_RETRY,
  photoErrorAction,
} from '@/lib/work-logs/photos';

import styles from './work-logs.module.css';

/**
 * The log's photos as thumbnails, opening a lightbox (a native `<dialog>`: focus moves in and
 * back, Escape closes, the page is inert). Images come from the short-lived signed URLs the API
 * puts on ready attachments; when one fails to load (expired link), `onRefetch` fetches the list
 * ONCE for fresh URLs (keyed on `dataUpdatedAt`); if the fresh set fails too, an error with a retry
 * button replaces the gallery (no endless refetching). Arrow keys move between photos.
 */
export function PhotoGallery({
  photos,
  loading,
  error,
  dataUpdatedAt,
  onRetry,
  onRefetch,
}: Readonly<{
  photos: readonly Attachment[] | undefined;
  loading: boolean;
  error: unknown;
  /** When the current URL set was fetched (the query's `dataUpdatedAt`). */
  dataUpdatedAt: number;
  /** The user asked to try again. */
  onRetry: () => void;
  /** The one automatic refetch after an image failed to load. */
  onRefetch: () => void;
}>) {
  const [open, setOpen] = useState<number | null>(null);
  const [retry, setRetry] = useState(INITIAL_PHOTO_RETRY);
  const onImageError = () => {
    if (photoErrorAction(retry, dataUpdatedAt) === 'refetch') onRefetch();
    setRetry((state) => afterPhotoError(state, dataUpdatedAt));
  };
  const onImageLoad = () => setRetry((state) => afterPhotoLoad(state, dataUpdatedAt));
  const ready = (photos ?? []).filter((photo) => photo.url !== null);
  const total = ready.length;

  if (loading && photos === undefined) {
    return <LoadingState inline />;
  }
  if (error && photos === undefined) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }
  if (retry.gaveUp) {
    return (
      <ErrorState
        error={null}
        title={t('workLogs.photos.unavailable')}
        onRetry={() => {
          setRetry(INITIAL_PHOTO_RETRY);
          setOpen(null);
          onRetry();
        }}
      />
    );
  }
  if (total === 0) {
    return <p className={styles.muted}>{t('workLogs.photos.none')}</p>;
  }

  const current = open === null ? null : (ready[open] ?? null);
  const move = (delta: number) =>
    setOpen((index) => (index === null ? null : (index + delta + total) % total));

  return (
    <>
      <ul className={styles.gallery}>
        {ready.map((photo, index) => (
          <li key={photo.id}>
            <button
              type="button"
              className={styles.thumbButton}
              onClick={() => setOpen(index)}
              aria-label={t('workLogs.photos.open', { index: index + 1, total })}
            >
              {/* Signed, short-lived storage URLs: next/image would proxy and cache them. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className={styles.thumb}
                src={photo.thumbnailUrl ?? photo.url ?? undefined}
                alt={t('workLogs.photos.alt', { index: index + 1 })}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={onImageError}
                onLoad={onImageLoad}
              />
            </button>
          </li>
        ))}
      </ul>
      <Modal
        open={current !== null}
        onClose={() => setOpen(null)}
        title={t('workLogs.photos.viewerTitle', { index: (open ?? 0) + 1, total })}
        size="lg"
      >
        {current ? (
          <div
            className={styles.viewer}
            onKeyDown={(event) => {
              // "Next" is towards the inline end: right in English, left in Arabic.
              const forward = DIRECTION === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
              const backward = DIRECTION === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
              if (event.key === forward) move(1);
              if (event.key === backward) move(-1);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.viewerImage}
              src={current.url ?? undefined}
              alt={t('workLogs.photos.alt', { index: (open ?? 0) + 1 })}
              referrerPolicy="no-referrer"
              onError={onImageError}
              onLoad={onImageLoad}
            />
            {total > 1 ? (
              <div className={styles.viewerNav}>
                <Button onClick={() => move(-1)}>{t('workLogs.photos.previous')}</Button>
                <Button onClick={() => move(1)} autoFocus>
                  {t('workLogs.photos.next')}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </>
  );
}
