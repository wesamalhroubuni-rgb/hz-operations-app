'use client';

import type { WorkLog } from '@ops/shared';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';

import { MapView } from '@/components/map/map-view';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/layout';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { Badge, StatusBadge } from '@/components/ui/status-badge';
import { useCaller } from '@/hooks/use-caller';
import { useDirectory } from '@/hooks/use-directory';
import { useOrgTime } from '@/hooks/use-organization';
import {
  useLogType,
  useReviewWorkLog,
  useWorkLog,
  useWorkLogHistory,
  useWorkLogPhotos,
} from '@/hooks/use-work-logs';
import { formatNumber, t } from '@/i18n';
import { describeError } from '@/lib/api/errors';
import type { DirectoryIndex } from '@/lib/directory';
import type { OrgTime } from '@/lib/time';
import { WORK_LOGS_PATH } from '@/lib/work-logs/filters';
import { customFieldRows, syncFactsOf } from '@/lib/work-logs/format';
import {
  reviewErrorOf,
  reviewRefusalMessage,
  reviewStateMessage,
  reviewStateOf,
} from '@/lib/work-logs/review';

import { HistoryTimeline } from './history-timeline';
import { PhotoGallery } from './photo-gallery';
import { ReviewDialog, type ReviewDecision } from './review-dialog';
import styles from './work-logs.module.css';

function Card({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <section className={styles.card} aria-label={title}>
      <h2 className={styles.cardTitle}>{title}</h2>
      {children}
    </section>
  );
}

/**
 * `/work-logs/[id]`: everything about one log in the caller's scope (a 404 reads "not found or
 * you cannot see it"): summary, text, custom fields by the log type's definitions, photos (signed
 * URLs, lightbox), location on a small map, how it arrived (offline, phone clock, skew), the
 * history, and approve / reject with a note. The caller's own log never offers a review.
 */
export function WorkLogDetailPage({ id }: Readonly<{ id: string }>) {
  const orgTime = useOrgTime();
  const names = useDirectory();
  const log = useWorkLog(id);
  const loaded = log.data !== undefined;
  const history = useWorkLogHistory(id, loaded);
  const photos = useWorkLogPhotos(id, loaded && (log.data?.attachmentCount ?? 1) > 0);

  if (log.isLoading) {
    return (
      <>
        <PageHeader title={t('pages.workLogDetail.title')} />
        <LoadingState />
      </>
    );
  }
  if (!log.data) {
    return (
      <>
        <PageHeader title={t('pages.workLogDetail.title')} />
        <ErrorState error={log.error} onRetry={() => void log.refetch()} />
        <p>
          <Link href={WORK_LOGS_PATH} className={styles.link}>
            {t('workLogs.detail.back')}
          </Link>
        </p>
      </>
    );
  }

  const data = log.data;
  const located = data.location;

  return (
    <div className={styles.stack}>
      <p>
        <Link href={WORK_LOGS_PATH} className={styles.link}>
          {t('workLogs.detail.back')}
        </Link>
      </p>
      <PageHeader
        title={`${t('pages.workLogDetail.title')} · ${orgTime.dateTime(data.occurredAt)}`}
        description={names.user(data.authorId)}
        actions={
          <span className={styles.badges}>
            <StatusBadge kind="workLog" value={data.status} />
            {data.archivedAt ? <StatusBadge kind="archived" /> : null}
          </span>
        }
      />
      {data.archivedAt ? (
        <p className={`${styles.notice} ${styles.noticeWarning}`}>
          {t('workLogs.detail.archivedNotice', { when: orgTime.dateTime(data.archivedAt) })}
        </p>
      ) : null}
      <div className={styles.detailGrid}>
        <div className={styles.column}>
          <Card title={t('workLogs.detail.summary')}>
            <SummaryFacts log={data} names={names} orgTime={orgTime} />
          </Card>
          <Card title={t('workLogs.detail.text')}>
            {data.text && data.text.trim() !== '' ? (
              <p className={styles.entryText}>{data.text}</p>
            ) : (
              <p className={styles.muted}>{t('workLogs.detail.noText')}</p>
            )}
          </Card>
          <Card title={t('workLogs.fields.heading')}>
            <CustomFields log={data} orgTime={orgTime} />
          </Card>
          <Card title={t('workLogs.photos.heading')}>
            <PhotoGallery
              photos={(data.attachmentCount ?? 1) > 0 ? photos.data?.items : []}
              loading={photos.isLoading}
              error={photos.error}
              onRetry={() => void photos.refetch()}
              dataUpdatedAt={photos.dataUpdatedAt}
              onRefetch={() => void photos.refetch()}
            />
          </Card>
          <Card title={t('workLogs.detail.location')}>
            {located ? (
              <>
                <MapView
                  height="sm"
                  ariaLabel={t('workLogs.detail.mapLabel')}
                  markers={[
                    {
                      id: data.id,
                      latitude: located.latitude,
                      longitude: located.longitude,
                      accuracy: located.accuracy,
                      title: `${names.user(data.authorId)} · ${orgTime.time(data.occurredAt)}`,
                    },
                  ]}
                />
                <p className={styles.hint}>
                  {t('workLogs.detail.coordinates', {
                    latitude: formatNumber(located.latitude, 6),
                    longitude: formatNumber(located.longitude, 6),
                  })}
                  {located.accuracy !== null
                    ? ` · ${t('workLogs.detail.accuracy', { meters: formatNumber(located.accuracy, 0) })}`
                    : ''}
                </p>
              </>
            ) : (
              <p className={styles.muted}>{t('workLogs.detail.noLocation')}</p>
            )}
          </Card>
        </div>
        <div className={styles.column}>
          <Card title={t('workLogs.review.heading')}>
            <ReviewPanel log={data} names={names} orgTime={orgTime} />
          </Card>
          <Card title={t('workLogs.sync.heading')}>
            <SyncFacts log={data} orgTime={orgTime} />
          </Card>
          <Card title={t('workLogs.history.heading')}>
            <HistoryTimeline
              history={history.data}
              loading={history.isLoading}
              error={history.error}
              onRetry={() => void history.refetch()}
              orgTime={orgTime}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function SummaryFacts({
  log,
  names,
  orgTime,
}: Readonly<{ log: WorkLog; names: DirectoryIndex; orgTime: OrgTime }>) {
  const none = t('common.none');
  return (
    <dl className={styles.facts}>
      <dt>{t('workLogs.detail.occurredAt')}</dt>
      <dd>{orgTime.dateTime(log.occurredAt)}</dd>
      <dt>{t('workLogs.detail.worker')}</dt>
      <dd>{names.user(log.authorId)}</dd>
      <dt>{t('workLogs.detail.site')}</dt>
      <dd>{names.site(log.siteId) || none}</dd>
      <dt>{t('workLogs.detail.team')}</dt>
      <dd>{names.team(log.teamId) || none}</dd>
      <dt>{t('workLogs.detail.logType')}</dt>
      <dd>{names.logType(log.logTypeId) || none}</dd>
      <dt>{t('workLogs.detail.task')}</dt>
      <dd>
        {log.taskId ? (
          <Link href={`/tasks/${encodeURIComponent(log.taskId)}`} className={styles.link}>
            {t('workLogs.detail.openTask')}
          </Link>
        ) : (
          none
        )}
      </dd>
      <dt>{t('workLogs.detail.source')}</dt>
      <dd>{t(`workLogs.source.${log.source}`)}</dd>
      <dt>{t('workLogs.detail.createdAt')}</dt>
      <dd>{orgTime.dateTime(log.createdAt)}</dd>
      <dt>{t('workLogs.detail.updatedAt')}</dt>
      <dd>{orgTime.dateTime(log.updatedAt)}</dd>
    </dl>
  );
}

function CustomFields({ log, orgTime }: Readonly<{ log: WorkLog; orgTime: OrgTime }>) {
  const logType = useLogType(log.logTypeId);
  if (log.logTypeId !== null && logType.isLoading) {
    return <LoadingState inline />;
  }
  const definitions = logType.data?.fields ?? null;
  const rows = customFieldRows(
    log.logTypeId === null ? [] : definitions,
    log.customFields,
    orgTime,
  );
  if (rows.length === 0) {
    return <p className={styles.muted}>{t('workLogs.fields.none')}</p>;
  }
  return (
    <>
      {logType.error ? <p className={styles.hint}>{t('workLogs.fields.loadFailed')}</p> : null}
      {logType.data &&
      log.logTypeVersion !== null &&
      log.logTypeVersion !== logType.data.version ? (
        <p className={styles.hint}>
          {t('workLogs.fields.versionNote', {
            logged: log.logTypeVersion,
            current: logType.data.version,
          })}
        </p>
      ) : null}
      <dl className={styles.facts}>
        {rows.map((row) => (
          <div key={row.key} className={styles.factRow}>
            <dt>
              {row.label}
              {row.removed ? (
                <>
                  {' '}
                  <Badge tone="muted" label={t('workLogs.fields.removedField')} />
                </>
              ) : null}
            </dt>
            <dd>
              {row.value}
              {row.help ? (
                <span className={`${styles.muted} ${styles.small}`}> · {row.help}</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}

function SyncFacts({ log, orgTime }: Readonly<{ log: WorkLog; orgTime: OrgTime }>) {
  const facts = syncFactsOf(log, orgTime);
  const unknown = t('workLogs.sync.unknown');
  return (
    <>
      <p className={styles.hint}>
        {facts.offline ? t('workLogs.sync.offline') : t('workLogs.sync.online')}
      </p>
      <dl className={styles.facts}>
        <dt>{t('workLogs.sync.deviceTime')}</dt>
        <dd>{facts.deviceTime ?? unknown}</dd>
        <dt>{t('workLogs.sync.skew')}</dt>
        <dd>{facts.skew ?? unknown}</dd>
      </dl>
      {facts.flagged ? (
        <p className={`${styles.notice} ${styles.noticeWarning}`} role="note">
          {t('workLogs.sync.skewFlagged')}
        </p>
      ) : null}
    </>
  );
}

function ReviewPanel({
  log,
  names,
  orgTime,
}: Readonly<{ log: WorkLog; names: DirectoryIndex; orgTime: OrgTime }>) {
  const caller = useCaller();
  const state = reviewStateOf(caller.capabilities, caller.user.id, log);
  const explanation = reviewStateMessage(state);
  const review = useReviewWorkLog(log.id);
  const [decision, setDecision] = useState<ReviewDecision | null>(null);
  const [done, setDone] = useState<ReviewDecision | null>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const failure = review.error ? reviewErrorOf(review.error) : null;
  const errorText = review.error
    ? failure
      ? reviewRefusalMessage(failure)
      : describeError(review.error)
    : null;

  async function confirm(note: string | undefined) {
    if (decision === null) return;
    try {
      await review.mutateAsync({ status: decision, note, expectedVersion: log.version });
      setDone(decision);
      setDecision(null);
      // Move focus to the confirmation, so keyboard and screen-reader users hear the outcome.
      requestAnimationFrame(() => statusRef.current?.focus());
    } catch {
      // Shown in the dialog.
    }
  }

  function open(next: ReviewDecision) {
    review.reset();
    setDone(null);
    setDecision(next);
  }

  return (
    <>
      {log.review ? (
        <div>
          <p className={styles.hint}>{t('workLogs.review.lastReview')}</p>
          <p>
            {t('workLogs.review.reviewedBy', {
              status: t(`status.workLog.${log.status}`),
              name: names.user(log.review.reviewedById),
              when: orgTime.dateTime(log.review.reviewedAt),
            })}
          </p>
          {log.review.note ? (
            <p className={styles.entryText}>
              {t('workLogs.review.reviewNote', { note: log.review.note })}
            </p>
          ) : null}
        </div>
      ) : null}
      {done ? (
        <p
          ref={statusRef}
          tabIndex={-1}
          className={`${styles.notice} ${styles.noticeSuccess}`}
          role="status"
        >
          {done === 'approved' ? t('workLogs.review.approved') : t('workLogs.review.rejected')}
        </p>
      ) : null}
      {state.kind === 'available' ? (
        <div className={styles.actions}>
          {state.approve ? (
            <Button variant="primary" onClick={() => open('approved')}>
              {t('workLogs.review.approve')}
            </Button>
          ) : null}
          {state.reject ? (
            <Button variant="danger" onClick={() => open('rejected')}>
              {t('workLogs.review.reject')}
            </Button>
          ) : null}
        </div>
      ) : state.kind === 'self' && caller.capabilities.reviewWorkLogs ? (
        <>
          {/* Shown disabled with the reason, so the missing action is not a mystery. */}
          <div className={styles.actions}>
            <Button variant="primary" disabled aria-describedby={`self-review-${log.id}`}>
              {t('workLogs.review.approve')}
            </Button>
            <Button variant="danger" disabled aria-describedby={`self-review-${log.id}`}>
              {t('workLogs.review.reject')}
            </Button>
          </div>
          <p id={`self-review-${log.id}`} className={styles.notice}>
            {explanation}
          </p>
        </>
      ) : (
        <p className={styles.hint}>{explanation}</p>
      )}
      <ReviewDialog
        decision={decision}
        title={
          decision === 'rejected'
            ? t('workLogs.review.rejectTitle')
            : t('workLogs.review.approveTitle')
        }
        description={
          decision === 'rejected'
            ? t('workLogs.review.rejectDescription')
            : t('workLogs.review.approveDescription')
        }
        busy={review.isPending}
        error={errorText}
        onConfirm={(note) => void confirm(note)}
        onCancel={() => setDecision(null)}
      />
    </>
  );
}
