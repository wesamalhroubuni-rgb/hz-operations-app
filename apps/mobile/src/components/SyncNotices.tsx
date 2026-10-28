import { useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { t } from '../i18n';
import { syncText } from '../i18n/syncText';
import { droppedReferenceKeys, readFailureView, signInWaitingText } from '../logic/sync';
import type { DroppedReference } from '../offline/engine';
import { droppedReferenceNoticesFor } from '../offline/engineApp';
import { Message } from './Message';
import { EmptyState, ErrorState } from './StateViews';
import { useSync } from './SyncProvider';

/**
 * A list's failed read. Before the first download (offline, empty cache) it says that nothing is
 * on the phone yet instead of showing a network error.
 */
export function SyncReadErrorState({
  kind,
  onRetry,
}: Readonly<{ kind: string; onRetry: () => void }>) {
  const { lastRefreshedAt } = useSync();
  if (readFailureView(kind, lastRefreshedAt) === 'notDownloaded') {
    return (
      <EmptyState
        icon="cloud-download-outline"
        message={t('sync.notDownloaded')}
        actionLabel={t('common.retry')}
        onAction={onRetry}
      />
    );
  }
  return <ErrorState onRetry={onRetry} />;
}

/** On the sign-in screen: whose changes wait on this phone since their session ended. */
export function SyncSignInNotice() {
  const { needsSignIn, pendingCountFor } = useAuth();
  const [known, setKnown] = useState<{ userId: string; pending: number } | null>(null);
  useEffect(() => {
    if (!needsSignIn) return undefined;
    let active = true;
    void pendingCountFor(needsSignIn.id).then((pending) => {
      if (active) setKnown({ userId: needsSignIn.id, pending });
    });
    return () => {
      active = false;
    };
  }, [needsSignIn, pendingCountFor]);
  const pending = needsSignIn && known?.userId === needsSignIn.id ? known.pending : null;
  if (!needsSignIn || pending === null) return null;
  return (
    <Message tone="notice" text={syncText(signInWaitingText(needsSignIn.displayName, pending))} />
  );
}

/** The task/site/team links the server dropped from this offline-created log, if any. */
export function useDroppedReferences(clientId: string | null | undefined): DroppedReference[] {
  const { userId } = useSync();
  const [fields, setFields] = useState<DroppedReference[]>([]);
  useEffect(() => {
    if (!userId || !clientId) return undefined;
    const notices = droppedReferenceNoticesFor(userId);
    let active = true;
    const load = () =>
      void notices.get(clientId).then((found) => {
        if (active) setFields(found ?? []);
      });
    load();
    const unsubscribe = notices.subscribe(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [userId, clientId]);
  return fields;
}

/** "This log was received, but its link to the task was removed ..." on the log's detail. */
export function SyncDroppedReferencesNotice({
  clientId,
}: Readonly<{ clientId: string | null | undefined }>) {
  const fields = useDroppedReferences(clientId);
  const keys = droppedReferenceKeys(fields);
  if (keys.length === 0) return null;
  return (
    <Message
      tone="notice"
      text={t('sync.droppedReferences.note', {
        fields: keys.map((key) => t(key)).join(t('sync.droppedReferences.separator')),
      })}
    />
  );
}
