import type { SmartCapture } from '@ops/shared';

import type { OfflineDatabase } from './db';
import type { LocalSmartCapture, SmartCaptureResults } from './types';

// The smart captures of one user as the phone keeps them (Phase 7, ADR-0010): table
// `smart_captures` of their own database, one JSON document per capture, keyed by the capture's
// clientId. Written when the worker captures (so a capture made offline shows at once), filled
// in by the sync engine when the server has processed it, and removed when the worker confirms
// or discards it. Never holds another user's captures.

export interface LocalCaptureStore extends SmartCaptureResults {
  /** Every capture, newest first. */
  list(): Promise<LocalSmartCapture[]>;
  get(captureClientId: string): Promise<LocalSmartCapture | null>;
  put(capture: LocalSmartCapture): Promise<void>;
  remove(captureClientId: string): Promise<void>;
  /** The local ids of the photos the captures still need (a Snap photo waits for its review). */
  referencedPhotoIds(): Promise<string[]>;
  referencedAudioIds(): Promise<string[]>;
  /**
   * Captures the server processed (`proposed` or `failed`) that the worker has not confirmed or
   * discarded yet. They count as unfinished work at sign-out (ADR-0008 section 8): a capture
   * still waiting for the server is counted through its queued write instead.
   */
  unreviewedCount(): Promise<number>;
  subscribe(listener: () => void): () => void;
}

const TABLE = 'smart_captures';

function parse(raw: string): LocalSmartCapture | null {
  try {
    return JSON.parse(raw) as LocalSmartCapture;
  } catch {
    return null;
  }
}

export function createLocalCaptureStore(db: OfflineDatabase): LocalCaptureStore {
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A listener's failure must not break the store.
      }
    }
  };

  async function all(): Promise<LocalSmartCapture[]> {
    const rows = await db.all(TABLE);
    return rows
      .map((row) => parse(row.value))
      .filter((capture): capture is LocalSmartCapture => capture !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return {
    list: all,

    async get(captureClientId) {
      const raw = await db.get(TABLE, captureClientId);
      return raw === null ? null : parse(raw);
    },

    async put(capture) {
      await db.put(TABLE, capture.captureClientId, JSON.stringify(capture));
      notify();
    },

    async saveResult(captureClientId: string, capture: SmartCapture) {
      const changed = await db.transaction(async (tx) => {
        const raw = await tx.get(TABLE, captureClientId);
        const local = raw === null ? null : parse(raw);
        // Discarded on the phone meanwhile: nothing to keep.
        if (!local) return false;
        await tx.put(TABLE, captureClientId, JSON.stringify({ ...local, capture }));
        return true;
      });
      if (changed) notify();
    },

    async remove(captureClientId) {
      await db.remove(TABLE, captureClientId);
      notify();
    },

    async referencedPhotoIds() {
      return (await all()).flatMap((capture) =>
        capture.input.kind === 'photo' ? [capture.input.photo.localId] : [],
      );
    },

    async referencedAudioIds() {
      return (await all()).flatMap((capture) =>
        capture.input.kind === 'voice' && capture.capture === null
          ? [capture.input.audio.localId]
          : [],
      );
    },

    async unreviewedCount() {
      return (await all()).filter(
        (capture) => capture.capture?.status === 'proposed' || capture.capture?.status === 'failed',
      ).length;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
