import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import {
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { S3FileStorage } from '../src/platform/storage/s3-file-storage';
import type { StorageSettings } from '../src/platform/storage/storage-settings';
import { at, createMembership, createSite, createTenant, createUser } from './support/factories';
import { makeJpeg, textBytes } from './support/test-images';
import { startTestApp, type ApiCaller, type TestApp } from './support/test-app';

// The upload flow against the REAL MinIO of docker-compose (127.0.0.1:9000), in a bucket of its
// own: `hz-attachments-test`, created by the storage at start-up (test mode) and emptied after
// the suite. It never touches the development bucket. Skipped when MinIO is not reachable or
// the STORAGE_* credentials are not in the environment (`pnpm test:integration` loads the root
// .env). Run alone with: pnpm --filter @ops/api test:integration -- storage-minio

const ENDPOINT = 'http://127.0.0.1:9000';
const TEST_BUCKET = 'hz-attachments-test';
const MAX_BYTES = 200_000;

function minioReachable(): boolean {
  if (!process.env.STORAGE_ACCESS_KEY_ID || !process.env.STORAGE_SECRET_ACCESS_KEY) {
    return false;
  }
  const probe = spawnSync(
    process.execPath,
    [
      '-e',
      `fetch('${ENDPOINT}/minio/health/live', { signal: AbortSignal.timeout(2000) })` +
        '.then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))',
    ],
    { timeout: 5000 },
  );
  return probe.status === 0;
}

const available = minioReachable();
if (!available) {
  console.warn('storage-minio.int-spec: MinIO not reachable at 127.0.0.1:9000; suite skipped.');
}

(available ? describe : describe.skip)('uploads against a real MinIO', () => {
  let ctx: TestApp;
  let storage: S3FileStorage;
  let admin: S3Client;
  let api: ApiCaller;
  let workLogId: string;

  const settings = (): StorageSettings => ({
    endpoint: ENDPOINT,
    publicEndpoint: ENDPOINT,
    region: process.env.STORAGE_REGION || 'us-east-1',
    bucket: TEST_BUCKET,
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? '',
    forcePathStyle: true,
    uploadMaxBytes: MAX_BYTES,
    uploadUrlTtlSeconds: 300,
    downloadUrlTtlSeconds: 300,
    nodeEnv: 'test',
  });

  async function emptyBucket(): Promise<void> {
    for (;;) {
      const listed = await admin.send(new ListObjectsV2Command({ Bucket: TEST_BUCKET }));
      const keys = (listed.Contents ?? []).flatMap((object) => (object.Key ? [object.Key] : []));
      if (keys.length === 0) return;
      await admin.send(
        new DeleteObjectsCommand({
          Bucket: TEST_BUCKET,
          Delete: { Objects: keys.map((Key) => ({ Key })) },
        }),
      );
    }
  }

  async function exists(key: string): Promise<boolean> {
    try {
      await admin.send(new HeadObjectCommand({ Bucket: TEST_BUCKET, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    if (process.env.STORAGE_BUCKET === TEST_BUCKET) {
      throw new Error('The development bucket must not be the test bucket');
    }
    const values = settings();
    storage = new S3FileStorage(values);
    await storage.onModuleInit(); // creates the private test bucket when missing (test mode)
    admin = new S3Client({
      endpoint: ENDPOINT,
      region: values.region,
      forcePathStyle: true,
      credentials: { accessKeyId: values.accessKeyId, secretAccessKey: values.secretAccessKey },
    });
    await emptyBucket();
    ctx = await startTestApp({
      storage,
      config: {
        STORAGE_ENDPOINT: ENDPOINT,
        STORAGE_PUBLIC_ENDPOINT: ENDPOINT,
        STORAGE_BUCKET: TEST_BUCKET,
        UPLOAD_MAX_BYTES: MAX_BYTES,
      },
    });
  });
  beforeEach(async () => {
    await ctx.reset();
    const tenant = await createTenant(ctx.prisma);
    const site = await createSite(ctx.prisma, tenant.organization.id);
    const worker = await createUser(ctx.prisma, tenant.organization.id);
    await createMembership(ctx.prisma, tenant.organization.id, worker.id, 'worker', {
      siteIds: [site.id],
    });
    workLogId = (
      await ctx.prisma.workLog.create({
        data: {
          organizationId: tenant.organization.id,
          authorId: worker.id,
          clientId: randomUUID(),
          occurredAt: at(),
          siteId: site.id,
        },
      })
    ).id;
    api = ctx.as(worker.id);
  });
  afterAll(async () => {
    await ctx?.close();
    if (admin) {
      await emptyBucket();
      admin.destroy();
    }
    storage?.onModuleDestroy();
  });

  const start = (sizeBytes: number, mimeType = 'image/jpeg') =>
    api.post(`/work-logs/${workLogId}/attachments`, { fileName: 'pump.jpg', mimeType, sizeBytes });

  const put = (
    upload: { url: string; headers: Record<string, string> },
    body: Uint8Array,
    headers = {},
  ) => fetch(upload.url, { method: 'PUT', headers: { ...upload.headers, ...headers }, body });

  const keyOf = async (id: string) =>
    (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } })).storageKey;

  it('uploads through the signed URL, completes, and serves the original and the thumbnail by signed URL only', async () => {
    const bytes = await makeJpeg(120, 90);
    const started = await start(bytes.byteLength);
    expect(started.status).toBe(201);
    const url = new URL(started.body.upload.url);
    expect(url.origin).toBe(ENDPOINT);
    expect(url.pathname.startsWith(`/${TEST_BUCKET}/org/`)).toBe(true);

    expect((await put(started.body.upload, bytes)).status).toBe(200);
    const completed = await api.post(`/attachments/${started.body.attachment.id}/complete`);
    expect(completed.status).toBe(200);
    expect(completed.body).toMatchObject({ status: 'ready', width: 120, height: 90 });

    const original = await fetch(completed.body.url as string);
    expect(original.status).toBe(200);
    // What is served is the re-encoded copy, not the uploaded object (which is deleted).
    const servedBytes = Buffer.from(await original.arrayBuffer());
    expect(servedBytes.byteLength).toBe(completed.body.sizeBytes);
    expect((await sharp(servedBytes).metadata()).format).toBe('jpeg');
    expect(
      await exists(new URL(started.body.upload.url).pathname.slice(TEST_BUCKET.length + 2)),
    ).toBe(false);
    const thumbnail = await fetch(completed.body.thumbnailUrl as string);
    expect(thumbnail.status).toBe(200);
    expect(thumbnail.headers.get('content-type')).toBe('image/jpeg');

    // The bucket is private: the same object without a signature is refused.
    const unsigned = new URL(completed.body.url as string);
    unsigned.search = '';
    expect((await fetch(unsigned)).status).toBe(403);
    // A signature does not carry over to another key.
    const tampered = new URL(completed.body.url as string);
    tampered.pathname = tampered.pathname.replace(/\.jpg$/, '.jpg.thumb.jpg');
    expect((await fetch(tampered)).status).toBe(403);
  });

  it('a PUT to the old upload URL after complete does not change what url serves; EXIF and appended data are gone', async () => {
    const tagged = await sharp({
      create: { width: 120, height: 90, channels: 3, background: { r: 30, g: 60, b: 90 } },
    })
      .jpeg()
      .withExif({ IFD0: { Make: 'TellTaleCam' } })
      .toBuffer();
    const bytes = new Uint8Array([...tagged, ...new TextEncoder().encode('<script>x</script>')]);
    const started = await start(bytes.byteLength);
    const id = started.body.attachment.id as string;
    const uploadKey = await keyOf(id);
    expect((await put(started.body.upload, bytes)).status).toBe(200);
    const completed = await api.post(`/attachments/${id}/complete`);
    expect(completed.status).toBe(200);
    const servedKey = await keyOf(id);
    expect(servedKey).not.toBe(uploadKey);
    expect(await exists(uploadKey)).toBe(false);

    const first = Buffer.from(await (await fetch(completed.body.url as string)).arrayBuffer());
    expect(first.includes('TellTaleCam')).toBe(false);
    expect(first.includes('<script>')).toBe(false);
    expect((await sharp(first).metadata()).exif).toBeUndefined();

    // The upload URL is still valid: different bytes of the same length are accepted by MinIO...
    const swapped = new Uint8Array(bytes.byteLength).fill(0x41);
    expect((await put(started.body.upload, swapped)).status).toBe(200);
    // ...but land on the upload key, which nothing serves.
    const again = await api.get(`/attachments/${id}`);
    const second = Buffer.from(await (await fetch(again.body.url as string)).arrayBuffer());
    expect(second.equals(first)).toBe(true);
  });

  it('the storage refuses a PUT with another content type or another size than the API signed', async () => {
    const bytes = await makeJpeg();
    const started = await start(bytes.byteLength);
    const id = started.body.attachment.id as string;

    const wrongType = await put(started.body.upload, bytes, { 'Content-Type': 'image/png' });
    expect(wrongType.status).toBe(403);
    const bigger = new Uint8Array(bytes.byteLength + 100);
    bigger.set(bytes);
    expect((await put(started.body.upload, bigger)).status).toBe(403);
    // Above the limit is impossible through the URL: the size is part of the signature.
    expect((await put(started.body.upload, new Uint8Array(MAX_BYTES + 1))).status).toBe(403);

    expect(await exists(await keyOf(id))).toBe(false);
    expect((await api.post(`/attachments/${id}/complete`)).status).toBe(409);
  });

  it('deletes refused content from the bucket and answers 422 with details[0].path "file"', async () => {
    const bytes = textBytes('definitely not a jpeg');
    const started = await start(bytes.byteLength);
    const id = started.body.attachment.id as string;
    expect((await put(started.body.upload, bytes)).status).toBe(200);
    const key = await keyOf(id);
    expect(await exists(key)).toBe(true);

    const completed = await api.post(`/attachments/${id}/complete`);
    expect(completed.status).toBe(422);
    expect(completed.body.details[0]).toEqual({ path: 'file', message: 'not_an_image' });
    expect(await exists(key)).toBe(false);
    expect(await exists(`${key}.thumb.jpg`)).toBe(false);
  });

  it('refuses a declared size above UPLOAD_MAX_BYTES before signing anything (400)', async () => {
    const response = await start(MAX_BYTES + 1);
    expect(response.status).toBe(400);
    expect(await ctx.prisma.attachment.count()).toBe(0);
  });

  it('an expired upload URL is refused by the storage; a renewed one works', async () => {
    const short = new S3FileStorage({ ...settings(), uploadUrlTtlSeconds: 1 });
    const bytes = await makeJpeg();
    const target = await short.createUploadTarget({
      storageKey: `expiry-check/${randomUUID()}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
    });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect((await put(target, bytes)).status).toBe(403);
    short.onModuleDestroy();

    const started = await start(bytes.byteLength);
    const renewed = await api.post(`/attachments/${started.body.attachment.id}/upload-url`);
    expect((await put(renewed.body.upload, bytes)).status).toBe(200);
    expect((await api.post(`/attachments/${started.body.attachment.id}/complete`)).status).toBe(
      200,
    );
  });
});
