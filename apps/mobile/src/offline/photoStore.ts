import type { LocalPhoto } from '../storage/localPhoto';
import {
  DEFAULT_PHOTO_STORAGE_LIMIT_BYTES,
  PHOTO_STORAGE_WARNING_RATIO,
  type LocalPhotoStore,
  type PhotoStorageLevel,
} from './types';

// Prepared photos waiting for upload, one folder per user (ADR-0008 section 8):
// `<documents>/offline-photos/<userId>/<localId>.jpg`. The photos arrive already resized and
// stripped of metadata (src/device/photos.ts). The file system sits behind `PhotoFiles`, so the
// rules (limit, cleanup) are unit-tested; `expoPhotoFiles.ts` is the phone's implementation.

export interface StoredPhotoFile {
  localId: string;
  uri: string;
  sizeBytes: number;
}

/** The file operations the photo store needs. Implementations never throw for a missing file. */
export interface PhotoFiles {
  /** Moves the file at `uri` into the user's folder as `<localId>.jpg`. */
  moveIn(userId: string, uri: string, localId: string): Promise<StoredPhotoFile>;
  /** The URI a photo has in the user's folder (whether or not it exists). */
  uriFor(userId: string, localId: string): string;
  exists(uri: string): Promise<boolean>;
  remove(uri: string): Promise<void>;
  /** The files in the user's folder. */
  list(userId: string): Promise<StoredPhotoFile[]>;
  removeFolder(userId: string): Promise<void>;
}

export function photoStorageLevel(usedBytes: number, limitBytes: number): PhotoStorageLevel {
  if (usedBytes >= limitBytes) return 'full';
  if (usedBytes >= limitBytes * PHOTO_STORAGE_WARNING_RATIO) return 'warning';
  return 'ok';
}

export function createLocalPhotoStore(
  files: PhotoFiles,
  userId: string,
  limitBytes: number = DEFAULT_PHOTO_STORAGE_LIMIT_BYTES,
): LocalPhotoStore {
  async function totalBytes(): Promise<number> {
    const stored = await files.list(userId);
    return stored.reduce((sum, file) => sum + file.sizeBytes, 0);
  }

  async function canAdd(sizeBytes: number): Promise<boolean> {
    return (await totalBytes()) + sizeBytes <= limitBytes;
  }

  return {
    userId,

    async save(photo: LocalPhoto) {
      const target = files.uriFor(userId, photo.localId);
      if (photo.uri === target && (await files.exists(target))) {
        return { ok: true, photo };
      }
      if (!(await canAdd(photo.sizeBytes))) return { ok: false, reason: 'full' };
      const stored = await files.moveIn(userId, photo.uri, photo.localId);
      return { ok: true, photo: { ...photo, uri: stored.uri, sizeBytes: stored.sizeBytes } };
    },

    exists: (photo) => files.exists(photo.uri),

    async delete(localId) {
      await files.remove(files.uriFor(userId, localId));
    },

    async deleteAllExcept(keepLocalIds) {
      const keep = new Set(keepLocalIds);
      let deleted = 0;
      for (const file of await files.list(userId)) {
        if (!keep.has(file.localId)) {
          await files.remove(file.uri);
          deleted += 1;
        }
      }
      return deleted;
    },

    totalBytes,

    async usage() {
      const usedBytes = await totalBytes();
      return { usedBytes, limitBytes, level: photoStorageLevel(usedBytes, limitBytes) };
    },

    canAdd,

    clear: () => files.removeFolder(userId),
  };
}

/** In-memory files for tests: `seed` puts a file where the picker would have left it. */
export function createMemoryPhotoFiles(): PhotoFiles & {
  seed(uri: string, sizeBytes: number): void;
  readonly files: ReadonlyMap<string, number>;
} {
  const data = new Map<string, number>();
  const folder = (userId: string) => `file:///documents/offline-photos/${userId}/`;
  const uriFor = (userId: string, localId: string) => `${folder(userId)}${localId}.jpg`;
  return {
    seed(uri, sizeBytes) {
      data.set(uri, sizeBytes);
    },
    get files() {
      return data;
    },
    uriFor,
    async moveIn(userId, uri, localId) {
      const target = uriFor(userId, localId);
      const size = data.get(uri);
      if (size === undefined) throw new Error('The photo file does not exist');
      data.delete(uri);
      data.set(target, size);
      return { localId, uri: target, sizeBytes: size };
    },
    exists: async (uri) => data.has(uri),
    remove: async (uri) => {
      data.delete(uri);
    },
    list: async (userId) =>
      [...data.entries()]
        .filter(([uri]) => uri.startsWith(folder(userId)))
        .map(([uri, sizeBytes]) => ({
          uri,
          sizeBytes,
          localId: uri.slice(folder(userId).length).replace(/\.jpg$/, ''),
        })),
    removeFolder: async (userId) => {
      for (const uri of [...data.keys()]) if (uri.startsWith(folder(userId))) data.delete(uri);
    },
  };
}
