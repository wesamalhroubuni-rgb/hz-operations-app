import { Directory, File, Paths } from 'expo-file-system';

import type { PhotoFiles, StoredPhotoFile } from './photoStore';

// The photo store's files on the phone: `<documents>/offline-photos/<userId>/<localId>.jpg`, in
// the app's private document directory (not the cache, which the system may clear).

const ROOT = 'offline-photos';

function userFolder(userId: string): Directory {
  if (!/^[A-Za-z0-9-]+$/.test(userId)) throw new Error('Unexpected user id for a photo folder');
  return new Directory(Paths.document, ROOT, userId);
}

function ensure(directory: Directory): Directory {
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

export const expoPhotoFiles: PhotoFiles = {
  uriFor(userId, localId) {
    return new File(userFolder(userId), `${localId}.jpg`).uri;
  },

  async moveIn(userId, uri, localId): Promise<StoredPhotoFile> {
    const destination = new File(ensure(userFolder(userId)), `${localId}.jpg`);
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
      const folder = userFolder(userId);
      if (!folder.exists) return [];
      return folder
        .list()
        .filter((entry): entry is File => entry instanceof File && entry.name.endsWith('.jpg'))
        .map((file) => ({
          localId: file.name.replace(/\.jpg$/, ''),
          uri: file.uri,
          sizeBytes: file.size ?? 0,
        }));
    } catch {
      return [];
    }
  },

  async removeFolder(userId) {
    try {
      const folder = userFolder(userId);
      if (folder.exists) folder.delete();
    } catch {
      // Already gone.
    }
  },
};
