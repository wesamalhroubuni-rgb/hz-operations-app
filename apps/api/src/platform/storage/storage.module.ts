import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FILE_STORAGE } from './file-storage';
import { ImageProcessor } from './images';
import { S3FileStorage } from './s3-file-storage';
import { STORAGE_SETTINGS, storageSettingsFromConfig } from './storage-settings';

/**
 * File storage (reusable platform component): binds `FILE_STORAGE` to the S3-compatible
 * implementation configured by the STORAGE_* and UPLOAD_* / DOWNLOAD_* settings, and exposes the
 * settings under `STORAGE_SETTINGS` (upload limit, URL lifetimes).
 *
 * Host requirements: a global `ConfigService` answering the keys read in ./storage-settings.ts.
 * Replace `FILE_STORAGE` to use another provider (the integration tests bind an in-memory fake).
 */
@Global()
@Module({
  providers: [
    {
      provide: STORAGE_SETTINGS,
      inject: [ConfigService],
      useFactory: storageSettingsFromConfig,
    },
    { provide: FILE_STORAGE, useClass: S3FileStorage },
    // One per process: it carries the process-wide limit on concurrent image decodes.
    { provide: ImageProcessor, useFactory: () => new ImageProcessor() },
  ],
  exports: [STORAGE_SETTINGS, FILE_STORAGE, ImageProcessor],
})
export class StorageModule {}
