import { defineBackgroundSyncTask } from './background';
import { createUserSyncEngine } from './engineApp';
import { registerSyncEngineFactory } from './runtime';
import { createInertSyncEngine } from './session';

// Imported once by `index.ts`, before the app renders:
// - plugs the real sync engine into the offline runtime's engine seam (every opened user's
//   session gets one; without an API client, e.g. no API URL configured, the inert engine);
// - defines the background task, which the OS may start before any screen exists.

registerSyncEngineFactory((context) =>
  context.api === null
    ? createInertSyncEngine(context)
    : createUserSyncEngine({
        userId: context.userId,
        store: context.store,
        queue: context.queue,
        photos: context.photos,
        api: context.api,
        onNeedsSignIn: context.onNeedsSignIn,
      }),
);

defineBackgroundSyncTask();
