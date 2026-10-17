import AsyncStorage from '@react-native-async-storage/async-storage';

import type { KeyValueStore } from './keyValueStore';

/**
 * The phone's key-value storage: AsyncStorage, because Expo Go includes it, it survives app
 * restarts, and it needs no schema. Non-secret state only (drafts, the upload queue); tokens
 * live in SecureStore.
 */
export const deviceStore: KeyValueStore = AsyncStorage;
