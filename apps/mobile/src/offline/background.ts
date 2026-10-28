import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import type { SyncRunResult } from './types';

// Best-effort background sync (ADR-0008, section 12). The OS decides when the task runs
// (Android WorkManager, iOS BGTaskScheduler; at most every 15 minutes, not in Expo Go). The task
// runs one `syncNow('background')` of the engine that is open for the signed-in user. When the
// OS starts the app headless (no screen, no session opened yet) there is no engine and the task
// does nothing: foreground sync never depends on this.

export const BACKGROUND_SYNC_TASK = 'ops-offline-sync';
/** Minimum interval asked of the OS, in minutes (the OS may wait longer). */
export const BACKGROUND_SYNC_MINUTES = 15;

type Runner = () => Promise<SyncRunResult>;
let runner: Runner | null = null;

/** Set by the sync provider while a user's engine is open; null when none is. */
export function setBackgroundSyncRunner(next: Runner | null): void {
  runner = next;
}

/** What the task does; exported for tests. Never throws. */
export async function runBackgroundSync(): Promise<BackgroundTask.BackgroundTaskResult> {
  if (runner === null) return BackgroundTask.BackgroundTaskResult.Success;
  try {
    await runner();
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

let defined = false;

/** Must run at module load of the app (before the OS can start the task). Safe to repeat. */
export function defineBackgroundSyncTask(): void {
  if (defined) return;
  defined = true;
  try {
    TaskManager.defineTask(BACKGROUND_SYNC_TASK, runBackgroundSync);
  } catch {
    // Not available (Expo Go on some platforms, tests): foreground sync only.
  }
}

/** Asks the OS to run the task. Resolves false where background tasks are unavailable. */
export async function registerBackgroundSync(): Promise<boolean> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return false;
    if (!(await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK))) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, {
        minimumInterval: BACKGROUND_SYNC_MINUTES,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** Stops the OS from running the task (sign-out). Never throws. */
export async function unregisterBackgroundSync(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
    }
  } catch {
    // Nothing to undo.
  }
}
