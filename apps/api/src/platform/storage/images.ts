import sharp from 'sharp';
import { ConcurrencyLimit } from './concurrency';

/**
 * Image verification, re-encoding and thumbnails for uploaded files (reusable platform
 * component).
 *
 * An upload is trusted only after its CONTENT has been checked: the magic bytes must be those of
 * the declared type, and the whole image must decode (libvips through `sharp`, failing on
 * corrupt or truncated data). The declared `Content-Type` and the file name are never trusted.
 *
 * What a host serves is never the uploaded file itself but a RE-ENCODED copy: the decoded pixels
 * written again in the same format, with the EXIF orientation applied, every piece of metadata
 * (EXIF, GPS, XMP, comments, ...) dropped, and nothing after the image (polyglots).
 *
 * Host requirements: the `sharp` package with its prebuilt native binary for the platform.
 * Imports nothing from the Operations domain.
 */

export type ImageMimeType = 'image/jpeg' | 'image/png';

/** Long edge of a thumbnail, in pixels. */
export const THUMBNAIL_MAX_EDGE = 320;
export const THUMBNAIL_MIME_TYPE = 'image/jpeg';
/**
 * Images with more pixels than this are refused (decompression bombs: a decoded image needs 3 to
 * 4 bytes per pixel). About 6000 x 4000; the phone app sends at most 1600 px on the long edge.
 */
export const MAX_IMAGE_PIXELS = 24_000_000;
/** JPEG quality of the re-encoded original. */
export const VERIFIED_JPEG_QUALITY = 85;
/** Decodes running at once in one process; the others wait (see {@link ImageProcessor}). */
export const IMAGE_DECODE_CONCURRENCY = 2;
/** How long a decode may wait for a free slot before it gives up (the host answers 503). */
export const IMAGE_DECODE_WAIT_MS = 30_000;

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((value, index) => bytes[index] === value);
}

/** The image type the first bytes announce, or null when they are neither JPEG nor PNG. */
export function sniffImageType(bytes: Uint8Array): ImageMimeType | null {
  if (startsWith(bytes, JPEG_MAGIC)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, PNG_MAGIC)) {
    return 'image/png';
  }
  return null;
}

export interface VerifiedImage {
  mimeType: ImageMimeType;
  /**
   * The re-encoded image to store and serve instead of the upload: same format (JPEG at
   * {@link VERIFIED_JPEG_QUALITY} with mozjpeg, or PNG), orientation applied, no metadata,
   * nothing appended.
   */
  data: Uint8Array;
  /** Of {@link data}, as displayed (a portrait photo is taller than wide). */
  width: number;
  height: number;
  /** JPEG, at most {@link THUMBNAIL_MAX_EDGE} on the long edge, made from {@link data}. */
  thumbnail: Uint8Array;
}

export type ImageCheck =
  | { ok: true; image: VerifiedImage }
  | { ok: false; reason: 'not_an_image' | 'type_mismatch' | 'corrupt' | 'too_many_pixels' };

/**
 * Checks that `bytes` really are an image of `declared` type, re-encodes it (see
 * {@link VerifiedImage.data}) and makes the thumbnail from the re-encoded image. Never throws
 * for bad input: the reason is returned. It decodes the whole image: call it through
 * {@link ImageProcessor}, which bounds how many decodes run at once.
 */
export async function verifyImage(bytes: Uint8Array, declared: ImageMimeType): Promise<ImageCheck> {
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return { ok: false, reason: 'not_an_image' };
  }
  if (sniffed !== declared) {
    return { ok: false, reason: 'type_mismatch' };
  }
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const options = { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS } as const;
  try {
    const metadata = await sharp(input, options).metadata();
    const expectedFormat = declared === 'image/jpeg' ? 'jpeg' : 'png';
    if (metadata.format !== expectedFormat || !metadata.width || !metadata.height) {
      return { ok: false, reason: 'type_mismatch' };
    }
    if (metadata.width * metadata.height > MAX_IMAGE_PIXELS) {
      return { ok: false, reason: 'too_many_pixels' };
    }
    // Re-encoding decodes every pixel: a corrupt or truncated file fails here. `rotate()` applies
    // the EXIF orientation; sharp writes no metadata unless asked to (`keepMetadata`, ...).
    const pipeline = sharp(input, options).rotate();
    const encoded =
      declared === 'image/jpeg'
        ? pipeline.jpeg({ quality: VERIFIED_JPEG_QUALITY, mozjpeg: true })
        : pipeline.png({ compressionLevel: 9 });
    const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(data, options)
      .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 75, mozjpeg: true })
      .toBuffer();
    return {
      ok: true,
      image: {
        mimeType: declared,
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        width: info.width,
        height: info.height,
        thumbnail: new Uint8Array(thumbnail),
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return {
      ok: false,
      reason: /pixel limit/i.test(message) ? 'too_many_pixels' : 'corrupt',
    };
  }
}

/**
 * {@link verifyImage} behind a process-wide limit of {@link IMAGE_DECODE_CONCURRENCY} decodes at
 * once, so a burst of uploads cannot exhaust the memory of the API process. A caller that waits
 * longer than {@link IMAGE_DECODE_WAIT_MS} for a slot gets `ConcurrencyLimitTimeoutError` (hosts
 * answer 503). `StorageModule` provides one instance per process.
 */
export class ImageProcessor {
  constructor(
    private readonly limit = new ConcurrencyLimit(IMAGE_DECODE_CONCURRENCY, IMAGE_DECODE_WAIT_MS),
  ) {}

  verify(bytes: Uint8Array, declared: ImageMimeType): Promise<ImageCheck> {
    return this.limit.run(() => verifyImage(bytes, declared));
  }
}
