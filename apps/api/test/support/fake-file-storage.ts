import {
  StorageUnavailableError,
  StoredFileTooLargeError,
  type DownloadUrlOptions,
  type FileStorage,
  type StoredFileInfo,
  type UploadTarget,
  type UploadTargetRequest,
} from '../../src/platform/storage/file-storage';

interface StoredObject {
  body: Uint8Array;
  contentType: string;
}

/** What the fake handed out as an upload target, for assertions. */
export interface IssuedUpload extends UploadTargetRequest {
  expiresAt: Date;
}

/**
 * An in-memory `FileStorage` for the integration tests. There is no HTTP endpoint behind the
 * URLs it signs: a test "uploads" with `upload(key, bytes)` (or `uploadTo(url, bytes)`, which
 * reads the key out of a URL the fake issued), and `fail = true` makes every call throw
 * `StorageUnavailableError` (the storage is down).
 *
 * URLs look like `fake-storage://upload/<key>?expires=<ms>` and `fake-storage://download/<key>?...`.
 */
export class FakeFileStorage implements FileStorage {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads: IssuedUpload[] = [];
  readonly deleted: string[] = [];
  /** When true, every call fails as if the storage could not be reached. */
  fail = false;

  private check(): void {
    if (this.fail) {
      throw new StorageUnavailableError('Fake storage is down');
    }
  }

  assertAvailable(): Promise<void> {
    this.check();
    return Promise.resolve();
  }

  createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
    const expiresAt = new Date(Date.now() + (request.expiresInSeconds ?? 300) * 1000);
    this.uploads.push({ ...request, expiresAt });
    return Promise.resolve({
      url: `fake-storage://upload/${request.storageKey}?expires=${expiresAt.getTime()}`,
      method: 'PUT',
      headers: { 'Content-Type': request.mimeType },
      expiresAt,
    });
  }

  stat(storageKey: string): Promise<StoredFileInfo | null> {
    this.check();
    const object = this.objects.get(storageKey);
    return Promise.resolve(
      object ? { sizeBytes: object.body.byteLength, mimeType: object.contentType } : null,
    );
  }

  read(storageKey: string, maxBytes: number): Promise<Uint8Array | null> {
    this.check();
    const object = this.objects.get(storageKey);
    if (!object) {
      return Promise.resolve(null);
    }
    if (object.body.byteLength > maxBytes) {
      return Promise.reject(new StoredFileTooLargeError(object.body.byteLength, maxBytes));
    }
    return Promise.resolve(object.body);
  }

  put(storageKey: string, body: Uint8Array, contentType: string): Promise<void> {
    this.check();
    this.objects.set(storageKey, { body, contentType });
    return Promise.resolve();
  }

  getDownloadUrl(
    storageKey: string,
    options: DownloadUrlOptions = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + (options.expiresInSeconds ?? 300) * 1000);
    return Promise.resolve({
      url: `fake-storage://download/${storageKey}?expires=${expiresAt.getTime()}`,
      expiresAt,
    });
  }

  delete(storageKey: string): Promise<void> {
    this.check();
    this.objects.delete(storageKey);
    this.deleted.push(storageKey);
    return Promise.resolve();
  }

  /** Stores bytes under a key, as the client's PUT would. */
  upload(storageKey: string, body: Uint8Array, contentType = 'application/octet-stream'): void {
    this.objects.set(storageKey, { body, contentType });
  }

  /** Stores bytes at the key of an upload URL this fake issued. */
  uploadTo(url: string, body: Uint8Array, contentType = 'application/octet-stream'): string {
    const key = FakeFileStorage.keyOf(url);
    this.upload(key, body, contentType);
    return key;
  }

  /** The storage key inside a URL this fake issued. */
  static keyOf(url: string): string {
    const match = /^fake-storage:\/\/(?:upload|download)\/([^?]+)/.exec(url);
    if (!match?.[1]) {
      throw new Error('Not a URL issued by the fake storage');
    }
    return match[1];
  }

  clear(): void {
    this.objects.clear();
    this.uploads.length = 0;
    this.deleted.length = 0;
    this.fail = false;
  }
}
