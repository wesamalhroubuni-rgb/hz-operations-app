import { randomUUID } from 'expo-crypto';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import type { LocalPhoto } from '../storage/localPhoto';
import { keepPhoto } from './files';
import { PHOTO_JPEG_QUALITY, photoFileName, resizeFor } from './photoSizing';

// Taking and picking photos, and preparing them for upload on the phone: resized so the long
// edge is at most 1600 px, re-encoded as JPEG at quality 0.7 (which also turns HEIC/HEIF into
// JPEG and drops the EXIF metadata, GPS included), then kept in the app's document folder until
// uploaded.

export type PhotoSource = 'camera' | 'library';

export type PickPhotosResult =
  | { status: 'picked'; photos: LocalPhoto[]; failed: number }
  | { status: 'cancelled' }
  | { status: 'denied' };

async function ensurePermission(source: PhotoSource): Promise<boolean> {
  const current =
    source === 'camera'
      ? await ImagePicker.getCameraPermissionsAsync()
      : await ImagePicker.getMediaLibraryPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  const asked =
    source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  return asked.granted;
}

/** Resizes and re-encodes one picked image, then moves it into the waiting folder. */
export async function preparePhoto(
  asset: Pick<ImagePicker.ImagePickerAsset, 'uri' | 'width' | 'height'>,
  index: number,
  now: Date = new Date(),
): Promise<LocalPhoto> {
  const context = ImageManipulator.manipulate(asset.uri);
  const resize = resizeFor(asset.width, asset.height);
  if (resize) context.resize(resize);
  const image = await context.renderAsync();
  const saved = await image.saveAsync({ compress: PHOTO_JPEG_QUALITY, format: SaveFormat.JPEG });
  const localId = randomUUID();
  const kept = await keepPhoto(saved.uri, localId);
  return {
    localId,
    uri: kept.uri,
    fileName: photoFileName(now, index),
    mimeType: 'image/jpeg',
    width: Math.round(saved.width),
    height: Math.round(saved.height),
    sizeBytes: kept.sizeBytes,
  };
}

/**
 * Opens the camera or the gallery (several photos at once, up to `limit`) and prepares what was
 * chosen. A photo that cannot be prepared is counted in `failed`; the others are kept.
 */
export async function pickPhotos(
  source: PhotoSource,
  limit: number,
  startIndex: number,
): Promise<PickPhotosResult> {
  if (!(await ensurePermission(source))) return { status: 'denied' };
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    quality: 1,
    exif: false,
  };
  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync({
          ...options,
          allowsMultipleSelection: limit > 1,
          selectionLimit: limit,
          orderedSelection: true,
        });
  if (result.canceled || result.assets.length === 0) return { status: 'cancelled' };

  const photos: LocalPhoto[] = [];
  let failed = 0;
  for (const [offset, asset] of result.assets.slice(0, limit).entries()) {
    try {
      photos.push(await preparePhoto(asset, startIndex + offset));
    } catch {
      failed += 1;
    }
  }
  return { status: 'picked', photos, failed };
}
