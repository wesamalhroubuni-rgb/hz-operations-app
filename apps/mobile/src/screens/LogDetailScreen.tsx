import { spacing } from '@ops/shared';
import { StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { InfoRow } from '../components/InfoRow';
import { Message } from '../components/Message';
import { AttachmentGrid } from '../components/PhotoGrid';
import { LOG_STATUS_TONES } from '../components/rows';
import { ScreenContainer } from '../components/ScreenContainer';
import { ErrorState, LoadingState } from '../components/StateViews';
import { UploadList } from '../components/UploadList';
import { useData } from '../data/DataProvider';
import {
  readErrorKind,
  useAttachments,
  useEditWindowHours,
  useTask,
  useWorkLog,
} from '../data/queries';
import { useLogStatusChange } from '../hooks/useLogStatusChange';
import { useLookups } from '../hooks/useLookups';
import { useNow } from '../hooks/useNow';
import { useLogUploads } from '../hooks/useUploads';
import { formatDateTime, formatNumber, t } from '../i18n';
import { errorText } from '../i18n/errorText';
import { parseIso } from '../logic/dates';
import {
  canEditWorkLog,
  canResubmitWorkLog,
  canSubmitDraft,
  editWindowEndsAt,
} from '../logic/workLogs';
import type { StackScreenProps } from '../navigation/types';

function customFieldText(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');
  if (typeof value === 'number') return formatNumber(value, 6);
  return value;
}

/**
 * One of my logs: what was logged, its review status (and the rejection reason), its photos
 * (including those still uploading), and edit / resubmit while the API allows it.
 */
export function LogDetailScreen({ route, navigation }: Readonly<StackScreenProps<'LogDetail'>>) {
  const { logId } = route.params;
  const { user, uploads } = useData();
  const now = useNow(30_000);
  const query = useWorkLog(logId);
  const attachments = useAttachments(logId);
  const queued = useLogUploads(logId);
  const editWindowHours = useEditWindowHours();
  const lookups = useLookups();
  const log = query.data;
  const task = useTask(log?.taskId ?? undefined);
  const status = useLogStatusChange(log);

  if (query.isPending) return <LoadingState />;
  if (query.isError || !log) {
    return (
      <ErrorState
        message={errorText(readErrorKind(query.error))}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const logType = lookups.logType(log.logTypeId);
  const editable = canEditWorkLog(log, user.id, now, editWindowHours);
  const resubmittable = canResubmitWorkLog(log, user.id, now, editWindowHours);
  const submittable = canSubmitDraft(log, user.id, now, editWindowHours);
  const endsAt = editWindowEndsAt(log, editWindowHours);
  const occurred = parseIso(log.occurredAt);
  const reviewedAt = parseIso(log.review?.reviewedAt);
  const ready = attachments.data ?? [];

  const footer =
    editable || resubmittable || submittable ? (
      <>
        {resubmittable || submittable ? (
          <Button
            size="large"
            icon="send-outline"
            label={resubmittable ? t('logs.resubmit') : t('logs.submit')}
            busy={status.busy}
            onPress={() => void status.submit()}
          />
        ) : null}
        {editable ? (
          <Button
            variant={resubmittable || submittable ? 'secondary' : 'primary'}
            size={resubmittable || submittable ? 'default' : 'large'}
            icon="create-outline"
            label={t('logs.edit')}
            onPress={() => navigation.navigate('LogForm', { mode: 'edit', logId: log.id })}
          />
        ) : null}
      </>
    ) : undefined;

  return (
    <ScreenContainer
      refreshing={query.isRefetching}
      onRefresh={() => {
        void query.refetch();
        void attachments.refetch();
      }}
      footer={footer}
    >
      <AppText variant="title">{logType?.name ?? t('logs.generalNote')}</AppText>
      <Badge label={t(`logs.status.${log.status}`)} tone={LOG_STATUS_TONES[log.status]} />

      {status.done ? <Message tone="success" text={t(`logs.${status.done}`)} /> : null}
      {status.error ? <Message tone="error" text={errorText(status.error)} /> : null}

      {log.status === 'rejected' ? (
        <Message
          tone="error"
          text={`${t('logs.rejectedTitle')}. ${
            log.review?.note
              ? t('logs.rejectionReason', { note: log.review.note })
              : t('logs.noRejectionReason')
          }`}
        />
      ) : null}
      {log.status === 'approved' && reviewedAt ? (
        <Message
          tone="success"
          text={t('logs.approvedNote', { date: formatDateTime(reviewedAt) })}
        />
      ) : null}
      {log.status !== 'approved' && log.authorId === user.id && endsAt ? (
        <AppText variant="muted">
          {editable ? t('logs.editUntil', { date: formatDateTime(endsAt) }) : t('logs.editClosed')}
        </AppText>
      ) : null}

      <Card>
        <InfoRow label={t('logs.occurredAt')} value={occurred ? formatDateTime(occurred) : null} />
        <InfoRow label={t('logs.notes')} value={log.text} />
        <InfoRow label={t('logs.task')} value={task.data?.title ?? null} />
        <InfoRow label={t('logs.site')} value={lookups.siteName(log.siteId)} />
        <InfoRow label={t('logs.team')} value={lookups.teamName(log.teamId)} />
        <InfoRow
          label={t('logs.location')}
          value={
            log.location
              ? [
                  t('logs.locationValue', {
                    latitude: formatNumber(log.location.latitude, 5),
                    longitude: formatNumber(log.location.longitude, 5),
                  }),
                  log.location.accuracy !== null
                    ? t('logs.accuracy', { meters: Math.round(log.location.accuracy) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(', ')
              : t('logs.noLocation')
          }
        />
      </Card>

      {logType && Object.keys(log.customFields).length > 0 ? (
        <Card>
          <AppText variant="heading">{t('logs.details')}</AppText>
          {logType.fields.map((field) => {
            const value = log.customFields[field.key];
            return value === undefined ? null : (
              <InfoRow key={field.key} label={field.label} value={customFieldText(value)} />
            );
          })}
        </Card>
      ) : null}

      <View style={styles.section}>
        <AppText variant="heading">{t('logs.photos')}</AppText>
        {attachments.isPending ? (
          <LoadingState />
        ) : attachments.isError ? (
          <ErrorState onRetry={() => void attachments.refetch()} />
        ) : ready.length === 0 && queued.length === 0 ? (
          <AppText variant="muted">{t('logs.noPhotos')}</AppText>
        ) : (
          <AttachmentGrid
            attachments={ready}
            onOpen={(attachment, index) =>
              navigation.navigate('PhotoViewer', {
                uri: attachment.url ?? attachment.thumbnailUrl ?? '',
                title: t('logs.photoLabel', { index: index + 1, count: ready.length }),
              })
            }
          />
        )}
        <UploadList
          items={queued}
          onRetry={() => uploads.retry(log.id)}
          onDiscard={(localId) => void uploads.discard(localId)}
        />
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  section: {
    gap: spacing.md,
  },
});
