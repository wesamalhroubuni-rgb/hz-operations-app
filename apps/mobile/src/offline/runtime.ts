import type { ApiClient } from '@ops/shared';
import { randomUUID } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { deviceStore } from '../storage/deviceStore';
import { createUserSyncEngine } from './engineApp';
import { expoPhotoFiles } from './expoPhotoFiles';
import { createKeptUsersRegister, createOfflineIdentityStore } from './identity';
import {
  createInertSyncEngine,
  createOfflineSessionFactory,
  type OfflineSessionParts,
} from './session';
import { deleteUserDatabase, openUserDatabase } from './sqliteDatabase';
import type { SyncEngine } from './types';

// The app's one offline runtime: the real adapters (expo-sqlite, expo-file-system, SecureStore,
// AsyncStorage) behind the logic of this folder. Screens never import it; the data provider, the
// auth provider and the sign-out hook do.

/** What the sync engine factory gets for one opened user. */
export interface AppEngineContext extends OfflineSessionParts {
  /** The authenticated API client of the session (`authSession.client`). */
  api: ApiClient | null;
  /** Call when the session cannot be renewed (refresh refused): the app asks to sign in again. */
  onNeedsSignIn: () => void;
}

export type AppSyncEngineFactory = (context: AppEngineContext) => SyncEngine;

// ENGINE SEAM: the real engine (engineApp.ts) for a session with an API client; the inert one
// (reports the queue, sends nothing) when the app has no API URL.
let engineFactory: AppSyncEngineFactory = (context) =>
  context.api === null
    ? createInertSyncEngine(context)
    : createUserSyncEngine({ ...context, api: context.api });
let apiClient: ApiClient | null = null;
let sessionLost: () => void = () => undefined;

/** Called once by the sync engine module: how to build the engine of an opened user. */
export function registerSyncEngineFactory(factory: AppSyncEngineFactory): void {
  engineFactory = factory;
}

/** Set by the data layer: the API client the engine sends with. */
export function setOfflineApiClient(client: ApiClient | null): void {
  apiClient = client;
}

/** Set by the auth provider: what happens when the engine finds the session gone. */
export function setSessionLostHandler(handler: () => void): void {
  sessionLost = handler;
}

export const offlineIdentity = createOfflineIdentityStore(SecureStore);
export const keptUsers = createKeptUsersRegister(deviceStore);

export const offlineSessions = createOfflineSessionFactory({
  openDatabase: openUserDatabase,
  deleteDatabase: deleteUserDatabase,
  photoFiles: expoPhotoFiles,
  kept: keptUsers,
  legacy: deviceStore,
  newId: randomUUID,
  clock: () => new Date(),
  createEngine: (parts) =>
    engineFactory({ ...parts, api: apiClient, onNeedsSignIn: () => sessionLost() }),
});

/** A new UUID for clientIds and idempotency keys. */
export const newOfflineId: () => string = randomUUID;
