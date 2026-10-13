/**
 * Where attachment bytes live. This is an interface only: NO implementation is bound to
 * {@link FILE_STORAGE} yet and nothing injects it. Phase 4 adds a provider (object storage or
 * local disk) and binds it, for example:
 *
 *   { provide: FILE_STORAGE, useClass: S3FileStorage }
 *
 * The design assumes direct uploads: the API never streams file bytes. It hands the client a
 * short-lived target to upload to, then records the attachment metadata once the upload is done.
 *
 * This file imports nothing from the Operations domain, so it can move to `src/platform` as it
 * is when a second product needs it.
 */

/** Injection token for the {@link FileStorage} implementation. */
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface UploadTargetRequest {
  /** Key the file will be stored under, chosen by the API (never by the client). */
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  /** How long the target stays valid. The implementation applies its own default and maximum. */
  expiresInSeconds?: number;
}

/** Everything a client needs to upload one file straight to the storage. */
export interface UploadTarget {
  url: string;
  method: 'PUT' | 'POST';
  /** Headers the client must send with the upload, exactly as given. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadUrlOptions {
  expiresInSeconds?: number;
  /** File name to suggest to the browser when it saves the file. */
  fileName?: string;
}

export interface StoredFileInfo {
  sizeBytes: number;
  mimeType: string | null;
}

export interface FileStorage {
  /** A short-lived target the client uploads one file to. */
  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget>;

  /** What is stored under a key, or null when nothing is: used to confirm an upload finished. */
  stat(storageKey: string): Promise<StoredFileInfo | null>;

  /** A short-lived URL the client downloads the file from. */
  getDownloadUrl(
    storageKey: string,
    options?: DownloadUrlOptions,
  ): Promise<{ url: string; expiresAt: Date }>;

  /** Removes the stored file. Succeeds when the file is already gone. */
  delete(storageKey: string): Promise<void>;
}
