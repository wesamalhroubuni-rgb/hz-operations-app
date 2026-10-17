/**
 * Where uploaded file bytes live (reusable platform component). The implementation bound to
 * {@link FILE_STORAGE} by `StorageModule` is the S3-compatible `S3FileStorage` (MinIO in
 * development); the integration tests bind an in-memory fake.
 *
 * Direct uploads: the API never streams a client's upload. It hands the client a short-lived,
 * pre-signed target to PUT the bytes to, then reads the stored object back to verify it. Downloads
 * work the same way: short-lived signed URLs, issued only after the host has checked that the
 * caller may see the file.
 *
 * Host requirements: none beyond what the implementation states. This file imports nothing from
 * the Operations domain.
 */

/** Injection token for the {@link FileStorage} implementation. */
export const FILE_STORAGE = Symbol('FILE_STORAGE');

export interface UploadTargetRequest {
  /** Key the file will be stored under, chosen by the API (never by the client). */
  storageKey: string;
  /** Sent by the client as the `Content-Type` header; it is part of the signature. */
  mimeType: string;
  /**
   * Exact size of the upload. The implementation signs it as `Content-Length`, so the storage
   * refuses a body of any other size (this is what stops an oversized upload).
   */
  sizeBytes: number;
  /** How long the target stays valid. The implementation applies its own default. */
  expiresInSeconds?: number;
}

/** Everything a client needs to upload one file straight to the storage. */
export interface UploadTarget {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the upload, exactly as given. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface DownloadUrlOptions {
  expiresInSeconds?: number;
  /** File name to suggest to the browser when it saves the file. Sanitised by the storage. */
  fileName?: string;
}

export interface StoredFileInfo {
  sizeBytes: number;
  mimeType: string | null;
}

/** The storage could not be reached or answered with a server error. Hosts map it to 503. */
export class StorageUnavailableError extends Error {
  constructor(message = 'File storage is unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StorageUnavailableError';
  }
}

/** The stored object is larger than the caller allowed to read. */
export class StoredFileTooLargeError extends Error {
  constructor(
    readonly sizeBytes: number,
    readonly maxBytes: number,
  ) {
    super(`The stored file has ${sizeBytes} bytes, more than the ${maxBytes} allowed`);
    this.name = 'StoredFileTooLargeError';
  }
}

export interface FileStorage {
  /** Throws {@link StorageUnavailableError} when the storage (or its bucket) cannot be reached. */
  assertAvailable(): Promise<void>;

  /** A short-lived target the client uploads one file to. Signing makes no network call. */
  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget>;

  /** What is stored under a key, or null when nothing is: used to confirm an upload finished. */
  stat(storageKey: string): Promise<StoredFileInfo | null>;

  /**
   * The whole object, or null when nothing is stored under the key. Throws
   * {@link StoredFileTooLargeError} (without downloading it) when it is larger than `maxBytes`.
   */
  read(storageKey: string, maxBytes: number): Promise<Uint8Array | null>;

  /**
   * Writes an object the API produced itself (a re-encoded original, a thumbnail). Overwrites.
   * Hosts write these under keys for which no upload target was ever issued, so no client can
   * replace them.
   */
  put(storageKey: string, body: Uint8Array, contentType: string): Promise<void>;

  /** A short-lived URL the client downloads the file from. Signing makes no network call. */
  getDownloadUrl(
    storageKey: string,
    options?: DownloadUrlOptions,
  ): Promise<{ url: string; expiresAt: Date }>;

  /** Removes the stored file. Succeeds when the file is already gone. */
  delete(storageKey: string): Promise<void>;
}

/**
 * A file name that is safe in a `Content-Disposition` header: no path, no control characters,
 * no quotes or backslashes, at most 150 characters. Falls back to `file`.
 */
export function safeFileName(fileName: string | undefined): string {
  const base = (fileName ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f"\\;]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file' : cleaned;
}

/** `inline` disposition with an ASCII fallback name and the UTF-8 name (RFC 6266 / 5987). */
export function inlineContentDisposition(fileName: string | undefined): string {
  const safe = safeFileName(fileName);
  const ascii = safe.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
