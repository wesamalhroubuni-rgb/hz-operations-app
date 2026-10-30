/**
 * When a photo fails to load, its signed URL has most likely expired: fetch the list again once
 * for fresh URLs. If the fresh set fails too (storage unreachable, a broken object), stop and show
 * an error with a retry button instead of refetching forever. Keyed on the query's
 * `dataUpdatedAt`, which identifies one fetched set of URLs. Pure, so tested.
 */
export interface PhotoRetryState {
  /** `dataUpdatedAt` of the URL set whose failure caused the one automatic refetch, or null. */
  retriedFor: number | null;
  /** The automatic refetch did not help: show the error state. */
  gaveUp: boolean;
}

export const INITIAL_PHOTO_RETRY: PhotoRetryState = { retriedFor: null, gaveUp: false };

export type PhotoErrorAction = 'refetch' | 'wait' | 'giveUp';

/** What to do when an image of the set fetched at `dataUpdatedAt` fails to load. */
export function photoErrorAction(state: PhotoRetryState, dataUpdatedAt: number): PhotoErrorAction {
  if (state.gaveUp) {
    return 'wait';
  }
  if (state.retriedFor === null) {
    return 'refetch';
  }
  // The failing image still belongs to the set already retried: the refetch is on its way.
  return dataUpdatedAt === state.retriedFor ? 'wait' : 'giveUp';
}

/** The state after an image error (apply `photoErrorAction` first). */
export function afterPhotoError(state: PhotoRetryState, dataUpdatedAt: number): PhotoRetryState {
  switch (photoErrorAction(state, dataUpdatedAt)) {
    case 'refetch':
      return { retriedFor: dataUpdatedAt, gaveUp: false };
    case 'giveUp':
      return { ...state, gaveUp: true };
    case 'wait':
      return state;
  }
}

/**
 * An image of a newer set loaded: the refetch worked, so a later expiry may refetch again.
 */
export function afterPhotoLoad(state: PhotoRetryState, dataUpdatedAt: number): PhotoRetryState {
  return state.retriedFor !== null && dataUpdatedAt !== state.retriedFor && !state.gaveUp
    ? INITIAL_PHOTO_RETRY
    : state;
}
