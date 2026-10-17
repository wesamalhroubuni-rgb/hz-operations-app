import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  inlineContentDisposition,
  StorageUnavailableError,
  StoredFileTooLargeError,
  type DownloadUrlOptions,
  type FileStorage,
  type StoredFileInfo,
  type UploadTarget,
  type UploadTargetRequest,
} from './file-storage';
import { isStorageConfigured, STORAGE_SETTINGS, type StorageSettings } from './storage-settings';

/**
 * `FileStorage` on any S3-compatible object store (MinIO in development, S3 or another provider
 * in production), through the AWS SDK v3.
 *
 * Two clients:
 * - `internal`, on `STORAGE_ENDPOINT`, for the API's own calls (stat, read, put, delete, bucket);
 * - `signer`, on `STORAGE_PUBLIC_ENDPOINT`, used ONLY to sign URLs. A SigV4 signature covers the
 *   `Host` header, so a signed URL must name the address the phone or browser connects to; it
 *   makes no network call.
 *
 * Start-up: in `development` and `test` a missing bucket is created; when the storage cannot be
 * reached, a warning is logged and the API keeps booting (upload endpoints then answer 503). In
 * `production` the bucket must already exist, and a missing or unreachable bucket stops the boot.
 * The bucket is never made public: every read goes through a signed URL.
 *
 * Host requirements: the settings listed in ./storage-settings.ts under `STORAGE_SETTINGS`.
 * Imports nothing from the Operations domain.
 */
@Injectable()
export class S3FileStorage implements FileStorage, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('FileStorage');
  private readonly internalClient: S3Client | null = null;
  private readonly signerClient: S3Client | null = null;

  constructor(@Inject(STORAGE_SETTINGS) private readonly settings: StorageSettings) {
    // Incomplete settings only happen in a host that does not validate them (unit tests of
    // other modules): the storage then reports itself unavailable instead of failing to build.
    if (!isStorageConfigured(settings)) {
      return;
    }
    const common = {
      region: settings.region,
      forcePathStyle: settings.forcePathStyle,
      credentials: {
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      },
      // No automatic CRC32 checksum headers: they would end up in presigned URLs, and MinIO
      // versions differ in what they accept. Integrity is checked by verifying the content.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
    };
    this.internalClient = new S3Client({
      ...common,
      endpoint: settings.endpoint,
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 3000, requestTimeout: 20_000 },
    });
    this.signerClient = new S3Client({ ...common, endpoint: settings.publicEndpoint });
  }

  /** The client for the API's own calls (on `STORAGE_ENDPOINT`). */
  private get internal(): S3Client {
    if (!this.internalClient) {
      throw new StorageUnavailableError('File storage is not configured');
    }
    return this.internalClient;
  }

  /** The client that only signs URLs (on `STORAGE_PUBLIC_ENDPOINT`). */
  private get signer(): S3Client {
    if (!this.signerClient) {
      throw new StorageUnavailableError('File storage is not configured');
    }
    return this.signerClient;
  }

  async onModuleInit(): Promise<void> {
    const { bucket, nodeEnv } = this.settings;
    const mayCreate = nodeEnv === 'development' || nodeEnv === 'test';
    if (!this.internalClient) {
      this.logger.warn('File storage is not configured; uploads answer 503.');
      return;
    }
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: bucket }));
      return;
    } catch (error) {
      if (!isNotFound(error)) {
        const reason = describe(error);
        if (!mayCreate) {
          throw new Error(`File storage: bucket "${bucket}" cannot be checked (${reason})`, {
            cause: error,
          });
        }
        this.logger.warn(
          `File storage is unreachable at start-up (${reason}); uploads answer 503 until it is.`,
        );
        return;
      }
    }
    if (!mayCreate) {
      throw new Error(
        `File storage: bucket "${bucket}" does not exist. Create it (private) before starting ` +
          'the API in production.',
      );
    }
    try {
      await this.internal.send(new CreateBucketCommand({ Bucket: bucket }));
      this.logger.log(`Created the private bucket "${bucket}" (${nodeEnv} only).`);
    } catch (error) {
      this.logger.warn(`Could not create the bucket "${bucket}": ${describe(error)}`);
    }
  }

  onModuleDestroy(): void {
    this.internalClient?.destroy();
    this.signerClient?.destroy();
  }

  async assertAvailable(): Promise<void> {
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.settings.bucket }));
    } catch (error) {
      throw unavailable(error);
    }
  }

  async createUploadTarget(request: UploadTargetRequest): Promise<UploadTarget> {
    const expiresIn = request.expiresInSeconds ?? this.settings.uploadUrlTtlSeconds;
    const command = new PutObjectCommand({
      Bucket: this.settings.bucket,
      Key: request.storageKey,
      ContentType: request.mimeType,
      ContentLength: request.sizeBytes,
    });
    const url = await getSignedUrl(this.signer, command, {
      expiresIn,
      // Both are signed: the storage refuses another type or another size.
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': request.mimeType },
      expiresAt: new Date(Date.now() + expiresIn * 1000),
    };
  }

  async stat(storageKey: string): Promise<StoredFileInfo | null> {
    try {
      const head = await this.internal.send(
        new HeadObjectCommand({ Bucket: this.settings.bucket, Key: storageKey }),
      );
      return { sizeBytes: head.ContentLength ?? 0, mimeType: head.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw unavailable(error);
    }
  }

  async read(storageKey: string, maxBytes: number): Promise<Uint8Array | null> {
    const info = await this.stat(storageKey);
    if (!info) {
      return null;
    }
    if (info.sizeBytes > maxBytes) {
      throw new StoredFileTooLargeError(info.sizeBytes, maxBytes);
    }
    try {
      const object = await this.internal.send(
        new GetObjectCommand({
          Bucket: this.settings.bucket,
          Key: storageKey,
          // Never more than allowed, even if the object changed since the stat.
          Range: `bytes=0-${maxBytes}`,
        }),
      );
      const bytes = object.Body ? await object.Body.transformToByteArray() : new Uint8Array();
      if (bytes.byteLength > maxBytes) {
        throw new StoredFileTooLargeError(bytes.byteLength, maxBytes);
      }
      return bytes;
    } catch (error) {
      if (error instanceof StoredFileTooLargeError) {
        throw error;
      }
      if (isNotFound(error)) {
        return null;
      }
      throw unavailable(error);
    }
  }

  async put(storageKey: string, body: Uint8Array, contentType: string): Promise<void> {
    try {
      await this.internal.send(
        new PutObjectCommand({
          Bucket: this.settings.bucket,
          Key: storageKey,
          Body: body,
          ContentType: contentType,
          ContentLength: body.byteLength,
        }),
      );
    } catch (error) {
      throw unavailable(error);
    }
  }

  async getDownloadUrl(
    storageKey: string,
    options: DownloadUrlOptions = {},
  ): Promise<{ url: string; expiresAt: Date }> {
    const expiresIn = options.expiresInSeconds ?? this.settings.downloadUrlTtlSeconds;
    const command = new GetObjectCommand({
      Bucket: this.settings.bucket,
      Key: storageKey,
      ResponseContentDisposition: inlineContentDisposition(options.fileName),
    });
    const url = await getSignedUrl(this.signer, command, { expiresIn });
    return { url, expiresAt: new Date(Date.now() + expiresIn * 1000) };
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await this.internal.send(
        new DeleteObjectCommand({ Bucket: this.settings.bucket, Key: storageKey }),
      );
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw unavailable(error);
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return (
      error.$metadata.httpStatusCode === 404 ||
      error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.name === 'NoSuchBucket'
    );
  }
  return false;
}

/** A short reason for a log line: the error name and HTTP status, never a URL or a secret. */
function describe(error: unknown): string {
  if (error instanceof S3ServiceException) {
    return `${error.name}, HTTP ${error.$metadata.httpStatusCode ?? 'unknown'}`;
  }
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return typeof code === 'string' ? `${error.name} ${code}` : error.name;
  }
  return 'unknown error';
}

function unavailable(error: unknown): StorageUnavailableError {
  if (error instanceof StorageUnavailableError) {
    return error;
  }
  return new StorageUnavailableError(`File storage request failed (${describe(error)})`, {
    cause: error,
  });
}
