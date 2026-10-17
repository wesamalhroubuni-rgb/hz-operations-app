import sharp from 'sharp';
import { inlineContentDisposition, safeFileName } from './file-storage';
import { ConcurrencyLimit, ConcurrencyLimitTimeoutError, KeyedSerializer } from './concurrency';
import {
  ImageProcessor,
  MAX_IMAGE_PIXELS,
  sniffImageType,
  THUMBNAIL_MAX_EDGE,
  verifyImage,
} from './images';
import { S3FileStorage } from './s3-file-storage';
import type { StorageSettings } from './storage-settings';

async function image(
  format: 'jpeg' | 'png',
  width: number,
  height: number,
  orientation?: number,
): Promise<Uint8Array> {
  let pipeline = sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 200, b: 90 } },
  });
  pipeline = format === 'jpeg' ? pipeline.jpeg() : pipeline.png();
  if (orientation) {
    pipeline = pipeline.withMetadata({ orientation });
  }
  return new Uint8Array(await pipeline.toBuffer());
}

describe('safeFileName and inlineContentDisposition', () => {
  it.each([
    ['photo.jpg', 'photo.jpg'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\IMG 1.jpg', 'IMG 1.jpg'],
    ['a"b;c.jpg', 'abc.jpg'],
    ['line\r\nbreak.jpg', 'linebreak.jpg'],
  ])('cleans %j', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });

  it('falls back to "file" and caps the length', () => {
    expect(safeFileName('')).toBe('file');
    expect(safeFileName(undefined)).toBe('file');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('x'.repeat(400))).toHaveLength(150);
  });

  it('writes an ASCII fallback and the UTF-8 name', () => {
    expect(inlineContentDisposition('Çatı fotoğrafı.jpg')).toBe(
      'inline; filename="_at_ foto_raf_.jpg"; ' +
        "filename*=UTF-8''%C3%87at%C4%B1%20foto%C4%9Fraf%C4%B1.jpg",
    );
    expect(inlineContentDisposition('a"b.jpg')).toBe(
      'inline; filename="ab.jpg"; filename*=UTF-8\'\'ab.jpg',
    );
  });
});

describe('sniffImageType', () => {
  it('recognises JPEG and PNG by their magic bytes only', async () => {
    expect(sniffImageType(await image('jpeg', 4, 4))).toBe('image/jpeg');
    expect(sniffImageType(await image('png', 4, 4))).toBe('image/png');
    expect(sniffImageType(new TextEncoder().encode('GIF89a...'))).toBeNull();
    expect(sniffImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe('verifyImage', () => {
  it('accepts a real JPEG, reads its size and makes a small JPEG thumbnail', async () => {
    const result = await verifyImage(await image('jpeg', 1200, 800), 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([result.image.width, result.image.height]).toEqual([1200, 800]);
    const thumbnail = await sharp(Buffer.from(result.image.thumbnail)).metadata();
    expect(thumbnail.format).toBe('jpeg');
    expect([thumbnail.width, thumbnail.height]).toEqual([THUMBNAIL_MAX_EDGE, 213]);
    expect(thumbnail.exif).toBeUndefined();
  });

  it('does not enlarge a small image', async () => {
    const result = await verifyImage(await image('png', 20, 10), 'image/png');
    expect(result.ok && (await sharp(Buffer.from(result.image.thumbnail)).metadata()).width).toBe(
      20,
    );
  });

  it('reports the displayed size of a rotated photo (EXIF orientation 6)', async () => {
    const result = await verifyImage(await image('jpeg', 400, 300, 6), 'image/jpeg');
    expect(result.ok && [result.image.width, result.image.height]).toEqual([300, 400]);
  });

  it('re-encodes the original: same format, rotation applied, no EXIF/GPS/XMP left', async () => {
    const tagged = await sharp({
      create: { width: 400, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'SecretCam', Copyright: 'Somebody' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeDefined();

    const result = await verifyImage(new Uint8Array(tagged), 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const reencoded = await sharp(Buffer.from(result.image.data)).metadata();
    expect(reencoded.format).toBe('jpeg');
    expect([reencoded.width, reencoded.height]).toEqual([300, 400]);
    expect([result.image.width, result.image.height]).toEqual([300, 400]);
    expect(reencoded.exif).toBeUndefined();
    expect(reencoded.xmp).toBeUndefined();
    expect(reencoded.orientation).toBeUndefined();
    expect(Buffer.from(result.image.data).includes('SecretCam')).toBe(false);
  });

  it('drops data appended after the image (a polyglot) and keeps PNG as PNG', async () => {
    const jpeg = await image('jpeg', 40, 30);
    const appended = new Uint8Array([...jpeg, ...new TextEncoder().encode('<script>x</script>')]);
    const result = await verifyImage(appended, 'image/jpeg');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Buffer.from(result.image.data).includes('<script>')).toBe(false);

    const png = await verifyImage(await image('png', 30, 20), 'image/png');
    expect(png.ok && (await sharp(Buffer.from(png.image.data)).metadata()).format).toBe('png');
  });

  it('refuses more than MAX_IMAGE_PIXELS (24 MP)', async () => {
    expect(MAX_IMAGE_PIXELS).toBe(24_000_000);
    const big = await sharp({
      create: { width: 5000, height: 5000, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(await verifyImage(new Uint8Array(big), 'image/png')).toEqual({
      ok: false,
      reason: 'too_many_pixels',
    });
  });

  it.each([
    ['a PNG declared as JPEG', () => image('png', 8, 8), 'image/jpeg', 'type_mismatch'],
    ['a JPEG declared as PNG', () => image('jpeg', 8, 8), 'image/png', 'type_mismatch'],
    [
      'text',
      () => Promise.resolve(new TextEncoder().encode('hello')),
      'image/jpeg',
      'not_an_image',
    ],
    [
      'a JPEG header followed by garbage',
      () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8])),
      'image/jpeg',
      'corrupt',
    ],
    [
      'a truncated JPEG',
      async () => (await image('jpeg', 300, 300)).slice(0, 400),
      'image/jpeg',
      'corrupt',
    ],
  ] as const)('refuses %s', async (_name, make, declared, reason) => {
    expect(await verifyImage(await make(), declared)).toEqual({ ok: false, reason });
  });
});

describe('ConcurrencyLimit', () => {
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    return { promise, resolve };
  };

  it('runs at most max pieces of work at once, the rest in arrival order', async () => {
    const limit = new ConcurrencyLimit(2, 10_000);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const order: number[] = [];
    const runs = gates.map((gate, index) =>
      limit.run(async () => {
        order.push(index);
        await gate.promise;
        return index;
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect([limit.running, limit.waiting, order]).toEqual([2, 2, [0, 1]]);
    gates[1]!.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual([0, 1, 2]);
    gates.forEach((gate) => gate.resolve());
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect([limit.running, limit.waiting]).toEqual([0, 0]);
  });

  it('gives up after the wait timeout without running the work; a failure frees the slot', async () => {
    const limit = new ConcurrencyLimit(1, 20);
    const gate = deferred();
    const first = limit.run(() => gate.promise);
    const work = jest.fn(() => Promise.resolve('late'));
    await expect(limit.run(work)).rejects.toBeInstanceOf(ConcurrencyLimitTimeoutError);
    expect(work).not.toHaveBeenCalled();
    gate.resolve();
    await first;
    await expect(limit.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await limit.run(() => Promise.resolve('ok'))).toBe('ok');
  });

  it('ImageProcessor never decodes more than 2 images at once', async () => {
    const limit = new ConcurrencyLimit(2, 10_000);
    let peak = 0;
    const realRun = limit.run.bind(limit);
    jest.spyOn(limit, 'run').mockImplementation((work) =>
      realRun(async () => {
        peak = Math.max(peak, limit.running);
        return work();
      }),
    );
    const processor = new ImageProcessor(limit);
    const bytes = await image('jpeg', 200, 200);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => processor.verify(bytes, 'image/jpeg')),
    );
    expect(results.every((result) => result.ok)).toBe(true);
    expect(peak).toBe(2);
  });
});

describe('KeyedSerializer', () => {
  it('runs work for one key one after the other, even after a failure; other keys in parallel', async () => {
    const serializer = new KeyedSerializer();
    const events: string[] = [];
    const step =
      (name: string, ms: number, fail = false) =>
      async () => {
        events.push(`start ${name}`);
        await new Promise((resolve) => setTimeout(resolve, ms));
        events.push(`end ${name}`);
        if (fail) throw new Error(name);
        return name;
      };
    const a1 = serializer.run('a', step('a1', 20, true));
    const a2 = serializer.run('a', step('a2', 1));
    const b1 = serializer.run('b', step('b1', 1));
    await expect(a1).rejects.toThrow('a1');
    expect(await a2).toBe('a2');
    expect(await b1).toBe('b1');
    expect(events.indexOf('start a2')).toBeGreaterThan(events.indexOf('end a1'));
    expect(events.indexOf('start b1')).toBeLessThan(events.indexOf('end a1'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(serializer.size).toBe(0);
  });
});

describe('S3FileStorage signing', () => {
  const settings: StorageSettings = {
    endpoint: 'http://127.0.0.1:9000',
    publicEndpoint: 'http://192.168.43.10:9000',
    region: 'us-east-1',
    bucket: 'hz-attachments',
    accessKeyId: 'unit-test-key',
    secretAccessKey: 'unit-test-secret-not-real-0123456789',
    forcePathStyle: true,
    uploadMaxBytes: 1024,
    uploadUrlTtlSeconds: 120,
    downloadUrlTtlSeconds: 60,
    nodeEnv: 'test',
  };
  const storage = new S3FileStorage(settings);
  afterAll(() => storage.onModuleDestroy());

  it('signs an upload on the public endpoint, with type and length in the signature', async () => {
    const target = await storage.createUploadTarget({
      storageKey: 'org/o/work-logs/w/k.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 500,
    });
    const url = new URL(target.url);
    expect(url.host).toBe('192.168.43.10:9000');
    expect(url.pathname).toBe('/hz-attachments/org/o/work-logs/w/k.jpg');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';')).toEqual(
      expect.arrayContaining(['content-length', 'content-type', 'host']),
    );
    expect(url.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(target).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
  });

  it('signs a download with an inline disposition and the download lifetime', async () => {
    const { url } = await storage.getDownloadUrl('org/o/k.jpg', { fileName: '../x.jpg' });
    const parsed = new URL(url);
    expect(parsed.host).toBe('192.168.43.10:9000');
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(parsed.searchParams.get('response-content-disposition')).toBe(
      'inline; filename="x.jpg"; filename*=UTF-8\'\'x.jpg',
    );
  });
});
