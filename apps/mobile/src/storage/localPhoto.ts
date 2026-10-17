import { z } from 'zod';

/**
 * A photo prepared on the phone (resized, re-encoded as JPEG, metadata stripped) and copied into
 * the app's document folder, waiting to be attached to a work log.
 */
export const localPhotoSchema = z.object({
  localId: z.string().min(1),
  /** `file://` URI in the app's document folder. */
  uri: z.string().min(1),
  fileName: z.string().min(1),
  mimeType: z.literal('image/jpeg'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
});
export type LocalPhoto = z.infer<typeof localPhotoSchema>;
