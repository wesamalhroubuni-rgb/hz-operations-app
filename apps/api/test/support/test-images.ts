import sharp from 'sharp';

/** A real, small JPEG (solid colour), made with sharp. */
export async function makeJpeg(width = 64, height = 48): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer();
  return new Uint8Array(buffer);
}

/** A real, small PNG (solid colour), made with sharp. */
export async function makePng(width = 64, height = 48): Promise<Uint8Array> {
  const buffer = await sharp({
    create: { width, height, channels: 4, background: { r: 40, g: 120, b: 200, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

/** Bytes that are not an image at all. */
export function textBytes(text = 'this is not an image'): Uint8Array {
  return new TextEncoder().encode(text);
}
