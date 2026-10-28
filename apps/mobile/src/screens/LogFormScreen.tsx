import { Ionicons } from '@expo/vector-icons';
import { colors, customFieldDescriptors, spacing } from '@ops/shared';
import { useHeaderHeight } from '@react-navigation/elements';
import { useEffect, useMemo } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';

import { AppText } from '../components/AppText';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ChoiceButtons } from '../components/ChoiceButtons';
import { CustomFieldInput } from '../components/CustomFieldInput';
import { DateTimeField } from '../components/DateTimeField';
import { TextField } from '../components/FormField';
import { Message } from '../components/Message';
import { PickerField } from '../components/PickerField';
import { LocalPhotoGrid } from '../components/PhotoGrid';
import { ScreenContainer } from '../components/ScreenContainer';
import { ErrorState, LoadingState } from '../components/StateViews';
import { SyncPhotoStorageNotice } from '../components/SyncBanner';
import { iconSize } from '../components/sizes';
import { PHOTO_STORAGE_FULL } from '../data/repositories';
import { useLogForm } from '../hooks/useLogForm';
import { formatNumber, t } from '../i18n';
import { errorText } from '../i18n/errorText';
import { parseIso } from '../logic/dates';
import { LOG_TEXT_MAX_LENGTH } from '../logic/logForm';
import { isOpenTask } from '../logic/tasks';
import type { StackScreenProps } from '../navigation/types';

/** Log types shown as one-tap buttons; the rest are in a list below them. */
const TYPE_BUTTONS = 6;
const NO_TYPE = '__none__';

/**
 * The core screen: log work fast. Type of work first (most used first), its fields, notes,
 * photos, then the optional task/site/team and time. Location is captured on its own. The save
 * button is at the bottom; nothing typed is lost if saving fails or the screen is left.
 */
export function LogFormScreen({ route, navigation }: Readonly<StackScreenProps<'LogForm'>>) {
  const form = useLogForm(route.params);
  const headerHeight = useHeaderHeight();

  useEffect(() => {
    navigation.setOptions({ title: form.isNew ? t('logForm.titleNew') : t('logForm.titleEdit') });
  }, [form.isNew, navigation]);

  const descriptors = useMemo(
    () => (form.selectedType ? customFieldDescriptors(form.selectedType.fields) : []),
    [form.selectedType],
  );

  if (form.loadFailed) return <ErrorState onRetry={form.reload} />;
  if (form.loading) return <LoadingState />;

  const typeChoices = [
    ...form.orderedTypes
      .slice(0, TYPE_BUTTONS)
      .map((type) => ({ value: type.id, label: type.name })),
    { value: NO_TYPE, label: t('logForm.noType') },
  ];
  const moreTypes = form.orderedTypes.slice(TYPE_BUTTONS);
  const selectedIsMore = moreTypes.some((type) => type.id === form.values.logTypeId);
  const taskOptions = form.tasks
    .filter((task) => isOpenTask(task) || task.id === form.values.taskId)
    .map((task) => ({ value: task.id, label: task.title }));
  const siteOptions = form.sites
    .filter((site) => site.archivedAt === null || site.id === form.values.siteId)
    .map((site) => ({ value: site.id, label: site.name, description: site.code ?? undefined }));
  const teamOptions = form.teams
    .filter((team) => team.archivedAt === null || team.id === form.values.teamId)
    .map((team) => ({ value: team.id, label: team.name }));
  // The photos did not fit in the offline photo storage (the repositories' `photos` detail).
  const photoStorageFull = form.errors.other.photos === PHOTO_STORAGE_FULL;
  const hasFieldErrors =
    Object.keys(form.errors.customFields).length > 0 || form.errors.text || form.errors.occurredAt;

  async function onSave(): Promise<void> {
    const outcome = await form.save();
    if (outcome.kind === 'created') {
      if (outcome.logId) navigation.replace('LogDetail', { logId: outcome.logId });
      else navigation.goBack();
    } else if (outcome.kind === 'updated') {
      navigation.goBack();
    }
  }

  function confirmStartOver(): void {
    Alert.alert(t('logForm.startOver'), t('logForm.startOverConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('logForm.startOver'), style: 'destructive', onPress: () => void form.startOver() },
    ]);
  }

  const location = form.location;
  const locationText =
    location === null || location.status === 'capturing'
      ? t('logForm.location.capturing')
      : location.status === 'captured'
        ? !form.isNew
          ? t('logForm.location.kept')
          : location.location.accuracy !== null && location.location.accuracy !== undefined
            ? t('logForm.location.captured', {
                meters: formatNumber(Math.round(location.location.accuracy), 0),
              })
            : t('logForm.location.capturedNoAccuracy')
        : location.status === 'denied'
          ? t('logForm.location.denied')
          : t('logForm.location.unavailable');

  return (
    <ScreenContainer
      keyboardOffset={headerHeight}
      footer={
        <Button
          size="large"
          icon="checkmark-circle-outline"
          label={
            form.saving
              ? form.isNew
                ? t('logForm.saving')
                : t('common.loading')
              : form.isNew
                ? t('logForm.save')
                : t('logForm.saveChanges')
          }
          busy={form.saving}
          onPress={() => void onSave()}
        />
      }
    >
      {form.restored ? (
        <Message tone="notice" text={t('logForm.draftRestored')}>
          <Button variant="link" label={t('logForm.startOver')} onPress={confirmStartOver} />
        </Message>
      ) : null}
      {photoStorageFull ? (
        <Message tone="error" text={t('logForm.errors.photoStorageFull')} />
      ) : form.saveError ? (
        <Message tone="error" text={errorText(form.saveError)} />
      ) : null}
      {form.errors.empty ? <Message tone="error" text={t('logForm.errors.empty')} /> : null}
      {hasFieldErrors && !form.saveError ? (
        <Message tone="error" text={t('logForm.errors.checkFields')} />
      ) : null}
      {form.unchanged ? <Message tone="notice" text={t('logForm.noChanges')} /> : null}

      <ChoiceButtons
        label={t('logForm.type')}
        hint={form.orderedTypes.length > 1 ? t('logForm.mostUsed') : null}
        choices={typeChoices}
        value={
          form.values.logTypeId === null ? NO_TYPE : selectedIsMore ? null : form.values.logTypeId
        }
        onChange={(value) => form.setLogType(value === NO_TYPE || value === null ? null : value)}
      />
      {moreTypes.length > 0 ? (
        <PickerField
          label={t('logForm.chooseType')}
          options={moreTypes.map((type) => ({
            value: type.id,
            label: type.name,
            description: type.description ?? undefined,
          }))}
          value={selectedIsMore ? form.values.logTypeId : null}
          onChange={(value) => form.setLogType(value)}
        />
      ) : null}

      {descriptors.length > 0 ? (
        <Card>
          <AppText variant="heading">{t('logForm.fields')}</AppText>
          {descriptors.map((field) => (
            <CustomFieldInput
              key={field.key}
              field={field}
              value={form.values.customFields[field.key]}
              onChange={(value) => form.setCustomField(field.key, value)}
              error={form.errors.customFields[field.key]}
            />
          ))}
        </Card>
      ) : null}

      <TextField
        label={t('logForm.notes')}
        placeholder={t('logForm.notesPlaceholder')}
        value={form.values.text}
        onValueChange={form.setText}
        error={form.errors.text ? t('logForm.errors.textTooLong') : undefined}
        multiline
        autoCapitalize="sentences"
        autoCorrect
        spellCheck
        maxLength={LOG_TEXT_MAX_LENGTH}
      />

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <AppText variant="heading" style={styles.flex}>
            {t('logForm.photos')}
          </AppText>
          <AppText variant="muted">
            {t('logForm.photoCount', {
              count: form.maxPhotos - form.photoSlots,
              max: form.maxPhotos,
            })}
          </AppText>
        </View>
        {form.photos.length > 0 ? (
          <LocalPhotoGrid
            photos={form.photos}
            onRemove={form.removePhoto}
            onOpen={(uri, index) =>
              navigation.navigate('PhotoViewer', {
                uri,
                title: t('logs.photoLabel', { index: index + 1, count: form.photos.length }),
              })
            }
          />
        ) : null}
        {form.photoBusy ? (
          <View style={styles.inline} accessible accessibilityLiveRegion="polite">
            <ActivityIndicator color={colors.primary} />
            <AppText variant="secondary">{t('logForm.preparingPhotos')}</AppText>
          </View>
        ) : null}
        {form.photoNotice === 'cameraDenied' || form.photoNotice === 'libraryDenied' ? (
          <Message tone="notice" text={t(`logForm.${form.photoNotice}`)} />
        ) : form.photoNotice === 'limit' ? (
          <Message tone="notice" text={t('logForm.photoLimit', { max: form.maxPhotos })} />
        ) : form.photoNotice === 'failed' ? (
          <Message tone="error" text={t('logForm.photoFailed')} />
        ) : null}
        <SyncPhotoStorageNotice />
        <View style={styles.photoButtons}>
          <View style={styles.flex}>
            <Button
              icon="camera-outline"
              variant="secondary"
              label={t('logForm.takePhoto')}
              disabled={form.photoBusy || form.photoSlots === 0}
              onPress={() => void form.addPhotos('camera')}
            />
          </View>
          <View style={styles.flex}>
            <Button
              icon="images-outline"
              variant="secondary"
              label={t('logForm.pickPhotos')}
              disabled={form.photoBusy || form.photoSlots === 0}
              onPress={() => void form.addPhotos('library')}
            />
          </View>
        </View>
      </View>

      <PickerField
        label={t('logForm.task')}
        options={taskOptions}
        value={form.values.taskId}
        onChange={form.setTask}
        noneLabel={t('logForm.noTask')}
        error={form.errors.other.taskId ? t('logForm.fieldErrors.invalid') : undefined}
      />
      <PickerField
        label={t('logForm.site')}
        options={siteOptions}
        value={form.values.siteId}
        onChange={form.setSite}
        noneLabel={t('logForm.noSite')}
        error={form.errors.other.siteId ? t('logForm.fieldErrors.invalid') : undefined}
      />
      <PickerField
        label={t('logForm.team')}
        options={teamOptions}
        value={form.values.teamId}
        onChange={form.setTeam}
        noneLabel={t('logForm.noTeam')}
        error={form.errors.other.teamId ? t('logForm.fieldErrors.invalid') : undefined}
      />

      <DateTimeField
        label={t('logForm.when')}
        mode="datetime"
        value={parseIso(form.values.occurredAt)}
        onChange={form.setOccurredAt}
        emptyText={t('logForm.now')}
        clearLabel={t('logForm.useNow')}
        maximumDate={new Date()}
        error={
          form.errors.occurredAt === 'future'
            ? t('logForm.errors.occurredFuture')
            : form.errors.occurredAt === 'invalid'
              ? t('logForm.errors.occurredInvalid')
              : undefined
        }
      />

      <Card>
        <View style={styles.inline}>
          <Ionicons
            name={location?.status === 'captured' ? 'location' : 'location-outline'}
            size={iconSize.md}
            color={location?.status === 'captured' ? colors.success : colors.textSecondary}
          />
          <AppText variant="bodyStrong">{t('logForm.location.title')}</AppText>
        </View>
        <AppText variant="secondary" accessibilityLiveRegion="polite">
          {locationText}
        </AppText>
        {form.isNew &&
        location !== null &&
        (location.status === 'unavailable' || location.status === 'denied') ? (
          <Button
            variant="secondary"
            icon="refresh"
            label={t('logForm.location.retry')}
            onPress={form.retryLocation}
          />
        ) : null}
      </Card>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  section: {
    gap: spacing.md,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  inline: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  photoButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
});
