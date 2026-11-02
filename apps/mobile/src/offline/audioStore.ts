import type { PhotoFiles } from './photoStore';
import type { LocalAudio, LocalAudioStore } from './types';

// Voice notes waiting to be sent (Phase 7, ADR-0010), one folder per user
// (`<documents>/offline-audio/<userId>/<localId>.m4a`), like the offline photos. The file
// operations are the same as the photo store's (`PhotoFiles`); `expoAudioFiles` is the phone's.

export function createLocalAudioStore(files: PhotoFiles, userId: string): LocalAudioStore {
  return {
    userId,

    async save(audio: LocalAudio) {
      const target = files.uriFor(userId, audio.localId);
      if (audio.uri === target && (await files.exists(target))) return audio;
      const stored = await files.moveIn(userId, audio.uri, audio.localId);
      return { ...audio, uri: stored.uri, sizeBytes: stored.sizeBytes || audio.sizeBytes };
    },

    exists: (audio) => files.exists(audio.uri),

    async delete(localId) {
      await files.remove(files.uriFor(userId, localId));
    },

    async deleteAllExcept(keepLocalIds) {
      const keep = new Set(keepLocalIds);
      let removed = 0;
      for (const file of await files.list(userId)) {
        if (keep.has(file.localId)) continue;
        await files.remove(file.uri);
        removed += 1;
      }
      return removed;
    },

    clear: () => files.removeFolder(userId),
  };
}
