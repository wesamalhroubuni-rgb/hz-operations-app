import type { CustomFieldFormValue, LogType, WorkLog } from '@ops/shared';
import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useData } from '../data/DataProvider';
import {
  useAttachments,
  useLogTypes,
  useMyScope,
  useMyTasks,
  useRecentLogTypeUse,
  useSites,
  useTask,
  useTeams,
  useWorkLog,
} from '../data/queries';
import type { WriteError } from '../data/results';
import { deleteLocalFile, localFileExists } from '../device/files';
import { captureLocation } from '../device/location';
import type { LocationCapture } from '../device/locationLogic';
import { MAX_PHOTOS_PER_LOG, remainingPhotoSlots } from '../device/photoSizing';
import { pickPhotos, type PhotoSource } from '../device/photos';
import {
  buildCreateBody,
  buildUpdateBody,
  emptyLogFormErrors,
  errorsFromApiDetails,
  logFormValuesFromLog,
  newLogFormValues,
  withLogType,
  type LogFormErrors,
  type LogFormValues,
} from '../logic/logForm';
import { defaultPlacement, orderLogTypesByUse } from '../logic/workLogs';
import { isDraftWorthKeeping } from '../storage/draftStore';
import type { LocalPhoto } from '../storage/localPhoto';
import type { LogFormParams } from '../navigation/types';

const DRAFT_DEBOUNCE_MS = 400;

export type PhotoNotice = 'cameraDenied' | 'libraryDenied' | 'limit' | 'failed' | null;

export type SaveOutcome =
  | { kind: 'created'; logId: string | null }
  | { kind: 'updated'; logId: string }
  | { kind: 'unchanged' }
  | { kind: 'invalid' }
  | { kind: 'failed' };

/**
 * The state and actions of the work log form, new and edit. Everything the worker types stays in
 * memory until the log is saved; for a new log it is also kept as a draft on the phone, restored
 * the next time the form opens. Writes go through the work logs repository; photos are handed to
 * the upload queue after the log exists.
 */
export function useLogForm(params: LogFormParams) {
  const { user, repositories, drafts } = useData();
  const editLogId = params.mode === 'edit' ? params.logId : null;
  const isNew = params.mode === 'new';
  const prefillTaskId = params.mode === 'new' ? (params.taskId ?? null) : null;

  const logTypes = useLogTypes();
  const recentLogs = useRecentLogTypeUse();
  const myTasks = useMyTasks();
  const sites = useSites();
  const teams = useTeams();
  const scope = useMyScope();
  const prefillTask = useTask(prefillTaskId ?? undefined);
  const existing = useWorkLog(params.mode === 'edit' ? params.logId : undefined);
  const existingAttachments = useAttachments(params.mode === 'edit' ? params.logId : undefined);

  const [values, setValues] = useState<LogFormValues>(() =>
    newLogFormValues(randomUUID(), { taskId: prefillTaskId }),
  );
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState(false);
  const [errors, setErrors] = useState<LogFormErrors>(emptyLogFormErrors);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<WriteError | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const [location, setLocation] = useState<LocationCapture | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoNotice, setPhotoNotice] = useState<PhotoNotice>(null);
  // Site and team are filled in once (from the task or the worker's only site/team), and never
  // again after the worker picked one by hand.
  const [placementSettled, setPlacementSettled] = useState(false);
  const [placementTouched, setPlacementTouched] = useState(false);
  // Once the log is saved, the draft must not be written again by a late debounce.
  const saved = useRef(false);

  const orderedTypes = useMemo(
    () => orderLogTypesByUse(logTypes.data ?? [], recentLogs.data ?? []),
    [logTypes.data, recentLogs.data],
  );
  const logTypeById = useMemo(
    () => new Map((logTypes.data ?? []).map((type) => [type.id, type])),
    [logTypes.data],
  );
  const selectedType: LogType | null = values.logTypeId
    ? (logTypeById.get(values.logTypeId) ?? null)
    : null;

  /** Captures the location for a new log. Never blocks saving. */
  const startLocation = useCallback(() => {
    setLocation({ status: 'capturing' });
    void captureLocation((capture) => {
      setLocation(capture);
      if (capture.status === 'captured') {
        setValues((current) => ({ ...current, location: capture.location }));
      }
    });
  }, []);

  // New log: restore the draft if there is one, then capture the location if it has none.
  useEffect(() => {
    if (!isNew || ready) return;
    let cancelled = false;
    void drafts.load(user.id).then((draft) => {
      if (cancelled) return;
      if (draft) {
        setValues(draft.values);
        setPhotos(draft.photos.filter((photo) => localFileExists(photo.uri)));
        setRestored(true);
        setPlacementSettled(true);
      }
      setReady(true);
      if (draft?.values.location) {
        setLocation({ status: 'captured', location: draft.values.location });
      } else {
        startLocation();
      }
    });
    return () => {
      cancelled = true;
    };
  }, [drafts, isNew, ready, startLocation, user.id]);

  // Editing: fill the form once the log and the log types have loaded (state adjusted while
  // rendering, the React way to derive state from newly arrived data).
  if (!isNew && !ready && existing.data && logTypes.isSuccess) {
    const log: WorkLog = existing.data;
    setValues(
      logFormValuesFromLog(log, log.logTypeId ? (logTypeById.get(log.logTypeId) ?? null) : null),
    );
    if (log.location) {
      setLocation({
        status: 'captured',
        location: {
          latitude: log.location.latitude,
          longitude: log.location.longitude,
          accuracy: log.location.accuracy,
        },
      });
    }
    setReady(true);
  }

  // Editing: an unsaved edit of this log kept on the phone (a crash, a restart, leaving the
  // screen) comes back once the form is filled.
  const [editDraftChecked, setEditDraftChecked] = useState(false);
  useEffect(() => {
    if (isNew || !ready || editDraftChecked || editLogId === null) return;
    let cancelled = false;
    void drafts.loadEdit(user.id, editLogId).then((draft) => {
      if (cancelled) return;
      setEditDraftChecked(true);
      if (draft && draft.values.clientId === existing.data?.clientId) {
        setValues(draft.values);
        setPhotos(draft.photos.filter((photo) => localFileExists(photo.uri)));
        setRestored(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [drafts, editDraftChecked, editLogId, existing.data?.clientId, isNew, ready, user.id]);

  // New log: site and team from the task, or the worker's only site/team, once the data is there.
  const placementInputsReady = prefillTaskId
    ? prefillTask.data !== undefined
    : scope.data !== undefined && sites.data !== undefined && teams.data !== undefined;
  if (isNew && ready && !placementSettled && !placementTouched && placementInputsReady) {
    setPlacementSettled(true);
    const placement = defaultPlacement({
      task: prefillTask.data ?? null,
      memberOf: scope.data?.memberOf ?? null,
      sites: sites.data ?? [],
      teams: teams.data ?? [],
    });
    setValues((current) => ({ ...current, ...placement }));
  }

  // The edit draft: written shortly after every change, removed when nothing differs any more.
  useEffect(() => {
    if (isNew || !ready || !editDraftChecked || saving || saved.current) return;
    const original = existing.data;
    if (!original || editLogId === null) return;
    const timer = setTimeout(() => {
      const built = buildUpdateBody(values, original, selectedType, photos.length, new Date());
      if (photos.length > 0 || !built.ok || built.body !== null) {
        void drafts.saveEdit(user.id, editLogId, { values, photos });
      } else {
        void drafts.clearEdit(user.id, editLogId);
      }
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    drafts,
    editDraftChecked,
    editLogId,
    existing.data,
    isNew,
    photos,
    ready,
    saving,
    selectedType,
    user.id,
    values,
  ]);

  // The draft: written shortly after every change, removed when the form is empty again.
  useEffect(() => {
    if (!isNew || !ready || saving || saved.current) return;
    const timer = setTimeout(() => {
      if (
        isDraftWorthKeeping(values, photos, {
          taskId: prefillTaskId,
          siteId: values.siteId,
          teamId: values.teamId,
        })
      ) {
        void drafts.save(user.id, { values, photos });
      } else {
        void drafts.clear(user.id);
      }
    }, DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [drafts, isNew, photos, prefillTaskId, ready, saving, user.id, values]);

  const clearErrorsFor = useCallback((change: Partial<LogFormErrors>) => {
    setErrors((current) => ({ ...current, ...change }));
    setUnchanged(false);
  }, []);

  const setLogType = useCallback(
    (logTypeId: string | null) => {
      setValues((current) =>
        withLogType(current, logTypeId ? (logTypeById.get(logTypeId) ?? null) : null),
      );
      setErrors((current) => ({ ...current, customFields: {}, empty: undefined }));
    },
    [logTypeById],
  );

  const setCustomField = useCallback((key: string, value: CustomFieldFormValue) => {
    setValues((current) => ({
      ...current,
      customFields: { ...current.customFields, [key]: value },
    }));
    setErrors((current) => {
      if (!current.customFields[key]) return current;
      const customFields = { ...current.customFields };
      delete customFields[key];
      return { ...current, customFields };
    });
  }, []);

  const setText = useCallback(
    (text: string) => {
      setValues((current) => ({ ...current, text }));
      clearErrorsFor({ text: undefined, empty: undefined });
    },
    [clearErrorsFor],
  );

  const setTask = useCallback(
    (taskId: string | null) => {
      setValues((current) => {
        const task = (myTasks.data ?? []).find((candidate) => candidate.id === taskId);
        // Choosing a task brings its site and team, unless they were picked by hand.
        if (task && !placementTouched) {
          return {
            ...current,
            taskId,
            siteId: task.siteId ?? current.siteId,
            teamId: task.teamId ?? current.teamId,
          };
        }
        return { ...current, taskId };
      });
    },
    [myTasks.data, placementTouched],
  );

  const setSite = useCallback((siteId: string | null) => {
    setPlacementTouched(true);
    setValues((current) => ({ ...current, siteId }));
  }, []);

  const setTeam = useCallback((teamId: string | null) => {
    setPlacementTouched(true);
    setValues((current) => ({ ...current, teamId }));
  }, []);

  const setOccurredAt = useCallback(
    (date: Date | null) => {
      setValues((current) => ({ ...current, occurredAt: date ? date.toISOString() : null }));
      clearErrorsFor({ occurredAt: undefined });
    },
    [clearErrorsFor],
  );

  const retryLocation = startLocation;

  const existingPhotoCount = isNew ? 0 : (existingAttachments.data?.length ?? 0);
  const photoSlots = remainingPhotoSlots(existingPhotoCount + photos.length);

  const addPhotos = useCallback(
    async (source: PhotoSource) => {
      if (photoBusy) return;
      setPhotoNotice(null);
      if (photoSlots === 0) {
        setPhotoNotice('limit');
        return;
      }
      setPhotoBusy(true);
      try {
        const result = await pickPhotos(source, photoSlots, existingPhotoCount + photos.length);
        if (result.status === 'denied')
          setPhotoNotice(source === 'camera' ? 'cameraDenied' : 'libraryDenied');
        if (result.status === 'picked') {
          setPhotos((current) => [...current, ...result.photos]);
          setErrors((current) => ({ ...current, empty: undefined }));
          if (result.failed > 0) setPhotoNotice('failed');
        }
      } catch {
        setPhotoNotice('failed');
      } finally {
        setPhotoBusy(false);
      }
    },
    [existingPhotoCount, photoBusy, photoSlots, photos.length],
  );

  const removePhoto = useCallback((localId: string) => {
    setPhotos((current) => {
      const photo = current.find((candidate) => candidate.localId === localId);
      if (photo) void deleteLocalFile(photo.uri);
      return current.filter((candidate) => candidate.localId !== localId);
    });
  }, []);

  /** Throws the unsaved new log away (after the screen asked) and starts a fresh one. */
  const startOver = useCallback(async () => {
    for (const photo of photos) await deleteLocalFile(photo.uri);
    if (editLogId === null) await drafts.clear(user.id);
    else await drafts.clearEdit(user.id, editLogId);
    setPlacementSettled(false);
    setPlacementTouched(false);
    setPhotos([]);
    setErrors(emptyLogFormErrors());
    setSaveError(null);
    setRestored(false);
    setValues((current) => ({
      ...newLogFormValues(randomUUID(), { taskId: prefillTaskId }),
      location: current.location,
    }));
  }, [drafts, editLogId, photos, prefillTaskId, user.id]);

  const save = useCallback(async (): Promise<SaveOutcome> => {
    if (saving) return { kind: 'failed' };
    setSaveError(null);
    setUnchanged(false);
    const now = new Date();

    if (params.mode === 'new') {
      const built = buildCreateBody(values, selectedType, photos.length, now);
      if (!built.ok) {
        setErrors(built.errors);
        return { kind: 'invalid' };
      }
      setErrors(emptyLogFormErrors());
      setSaving(true);
      // The log and its photos go into the queue together (the photos are declared in it).
      const result = await repositories.workLogs.create(built.body, photos);
      if (!result.ok) {
        setSaving(false);
        setSaveError(result.error);
        if (result.error.kind === 'invalid') setErrors(errorsFromApiDetails(result.error.details));
        return { kind: 'failed' };
      }
      saved.current = true;
      const created = result.data;
      await drafts.clear(user.id);
      setSaving(false);
      // A queued log is shown by its clientId until the server has it.
      return { kind: 'created', logId: created.log?.id ?? created.clientId };
    }

    const original = existing.data;
    if (!original) return { kind: 'failed' };
    const built = buildUpdateBody(
      values,
      original,
      selectedType,
      existingPhotoCount + photos.length,
      now,
    );
    if (!built.ok) {
      setErrors(built.errors);
      return { kind: 'invalid' };
    }
    setErrors(emptyLogFormErrors());
    if (built.body === null && photos.length === 0) {
      setUnchanged(true);
      return { kind: 'unchanged' };
    }
    setSaving(true);
    if (built.body !== null) {
      const result = await repositories.workLogs.update(original.id, built.body);
      if (!result.ok) {
        setSaving(false);
        setSaveError(result.error);
        if (result.error.kind === 'invalid') setErrors(errorsFromApiDetails(result.error.details));
        return { kind: 'failed' };
      }
    }
    if (photos.length > 0) {
      const added = await repositories.attachments.add(original.id, photos);
      if (!added.ok) {
        setSaving(false);
        setSaveError(added.error);
        return { kind: 'failed' };
      }
    }
    saved.current = true;
    await drafts.clearEdit(user.id, original.id);
    if (original.id !== editLogId && editLogId !== null) await drafts.clearEdit(user.id, editLogId);
    setSaving(false);
    return { kind: 'updated', logId: original.id };
  }, [
    drafts,
    existing.data,
    existingPhotoCount,
    params.mode,
    photos,
    repositories,
    saving,
    selectedType,
    editLogId,
    user.id,
    values,
  ]);

  const loading = !ready || logTypes.isPending || (!isNew && existing.isPending);
  const loadFailed = logTypes.isError || (!isNew && existing.isError);

  return {
    isNew,
    loading,
    loadFailed,
    reload: () => {
      void logTypes.refetch();
      if (!isNew) void existing.refetch();
    },
    values,
    errors,
    saving,
    saveError,
    unchanged,
    restored,
    location,
    photos,
    photoBusy,
    photoNotice,
    photoSlots,
    maxPhotos: MAX_PHOTOS_PER_LOG,
    orderedTypes,
    selectedType,
    tasks: myTasks.data ?? [],
    sites: sites.data ?? [],
    teams: teams.data ?? [],
    setLogType,
    setCustomField,
    setText,
    setTask,
    setSite,
    setTeam,
    setOccurredAt,
    retryLocation,
    addPhotos,
    removePhoto,
    startOver,
    save,
  };
}
