import type { ConfigService } from '@nestjs/config';

/**
 * Settings of the file storage, read from the host's `ConfigService` (validated by the host's
 * environment schema). Every key is listed here, so a host knows exactly what to provide.
 */
export interface StorageSettings {
  /** Where the API itself reaches the storage (server to server). */
  endpoint: string;
  /** The address written into signed URLs: the one phones and browsers reach. */
  publicEndpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style URLs (`host/bucket/key`); MinIO needs it. */
  forcePathStyle: boolean;
  /** Largest upload accepted, in bytes. */
  uploadMaxBytes: number;
  uploadUrlTtlSeconds: number;
  downloadUrlTtlSeconds: number;
  /** `development` and `test` create a missing bucket at start-up; `production` never does. */
  nodeEnv: string;
}

export const STORAGE_SETTINGS = Symbol('STORAGE_SETTINGS');

function text(config: ConfigService, key: string): string {
  return config.get<string>(key) ?? '';
}

/**
 * Reads the settings. Missing values are not an error here (the host's environment schema
 * requires them at boot); a storage built from incomplete settings reports itself unavailable.
 * The numeric defaults are those of the environment schema.
 */
export function storageSettingsFromConfig(config: ConfigService): StorageSettings {
  return {
    endpoint: text(config, 'STORAGE_ENDPOINT'),
    publicEndpoint: text(config, 'STORAGE_PUBLIC_ENDPOINT'),
    region: text(config, 'STORAGE_REGION'),
    bucket: text(config, 'STORAGE_BUCKET'),
    accessKeyId: text(config, 'STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: text(config, 'STORAGE_SECRET_ACCESS_KEY'),
    forcePathStyle: config.get<boolean>('STORAGE_FORCE_PATH_STYLE') ?? true,
    uploadMaxBytes: config.get<number>('UPLOAD_MAX_BYTES') ?? 10 * 1024 * 1024,
    uploadUrlTtlSeconds: config.get<number>('UPLOAD_URL_TTL_SECONDS') ?? 300,
    downloadUrlTtlSeconds: config.get<number>('DOWNLOAD_URL_TTL_SECONDS') ?? 300,
    nodeEnv: config.get<string>('NODE_ENV') ?? 'production',
  };
}

/** True when every connection setting is present. */
export function isStorageConfigured(settings: StorageSettings): boolean {
  return [
    settings.endpoint,
    settings.publicEndpoint,
    settings.region,
    settings.bucket,
    settings.accessKeyId,
    settings.secretAccessKey,
  ].every((value) => value !== '');
}
