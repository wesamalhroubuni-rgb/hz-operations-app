import { Directory, File, Paths } from 'expo-file-system';

import type { PhotoFiles, StoredPhotoFile } from './photoStore';

// The offline files on the phone, in the app's private document directory (not the cache,
// which the system may clear), one folder per user:
// - photos: `<documents>/offline-photos/<userId>/<localId>.jpg` (ADR-0008);
// - voice notes: `<documents>/offline-audio/<userId>/<localId>.m4a` (Phase 7, ADR-0010).

function userFolder(root: string, userId: string): Directory {
  if (!/^[A-Za-z0-9-]+$/.test(userId)) throw new Error('Unexpected user id for a file folder');
  return new Directory(Paths.document, root, userId);
}

function ensure(directory: Directory): Directory {
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

/** Per-user files under `<documents>/<root>/<userId>/<localId>.<extension>`. */
export function createExpoFiles(root: string, extension: string): PhotoFiles {
  const suffix = `.${extension}`;
  return {
    uriFor(userId, localId) {
      return new File(userFolder(root, userId), `${localId}${suffix}`).uri;
    },

    async moveIn(userId, uri, localId): Promise<StoredPhotoFile> {
      const destination = new File(ensure(userFolder(root, userId)), `${localId}${suffix}`);
      const source = new File(uri);
      if (source.uri !== destination.uri) {
        if (destination.exists) destination.delete();
        await source.move(destination);
      }
      return { localId, uri: destination.uri, sizeBytes: destination.size };
    },

    async exists(uri) {
      try {
        return new File(uri).exists;
      } catch {
        return false;
      }
    },

    async remove(uri) {
      try {
        const file = new File(uri);
        if (file.exists) file.delete();
      } catch {
        // Already gone.
      }
    },

    async list(userId) {
      try {
        const folder = userFolder(root, userId);
        if (!folder.exists) return [];
        return folder
          .list()
          .filter((entry): entry is File => entry instanceof File && entry.name.endsWith(suffix))
          .map((file) => ({
            localId: file.name.slice(0, -suffix.length),
            uri: file.uri,
            sizeBytes: file.size ?? 0,
          }));
      } catch {
        return [];
      }
    },

    async removeFolder(userId) {
      try {
        const folder = userFolder(root, userId);
        if (folder.exists) folder.delete();
      } catch {
        // Already gone.
      }
    },
  };
}

export const expoPhotoFiles: PhotoFiles = createExpoFiles('offline-photos', 'jpg');
export const expoAudioFiles: PhotoFiles = createExpoFiles('offline-audio', 'm4a');
