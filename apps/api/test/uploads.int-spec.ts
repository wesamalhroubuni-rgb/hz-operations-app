import { randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { attachmentSchema } from '@ops/shared';
import sharp from 'sharp';
import {
  AttachmentCleanupService,
  PURGE_RETRY_HOURS,
} from '../src/operations/attachments/attachment-cleanup.service';
import { UPLOAD_RATE_LIMITS } from '../src/operations/attachments/attachments.service';
import { MAX_ATTACHMENTS_PER_WORK_LOG } from '../src/operations/access';
import { ConcurrencyLimitTimeoutError } from '../src/platform/storage/concurrency';
import { ImageProcessor } from '../src/platform/storage/images';
import {
  at,
  createMembership,
  createSite,
  createTenant,
  createUser,
  eventCounts,
  type Tenant,
} from './support/factories';
import { FakeFileStorage } from './support/fake-file-storage';
import { makeJpeg, makePng } from './support/test-images';
import { startTestApp, type ApiCaller, type ApiResponse, type TestApp } from './support/test-app';

// Upload validation and photo privacy (Phase 4), on the in-memory storage fake. The basic flow
// (start, complete, 409 before upload, the 400 bodies, content refusals, 503) is in
// work-logs.int-spec.ts; this suite adds the rules around it: who may add or see a photo, keys
// the client never influences, the per-log cap under concurrency, and the cleanup of abandoned
// uploads. Real MinIO: storage-minio.int-spec.ts. Example values only.

const HOUR = 3_600_000;

/** A PNG whose header announces `width` x `height` pixels (the pixel data is a few bytes). */
function pngHeaderClaiming(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // truecolour
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(Buffer.alloc(16))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('uploads: validation and photo privacy', () => {
  let ctx: TestApp;
  let tenant: Tenant;
  /** Site S: worker W (author), worker W2 (colleague, same site), supervisor SUP. */
  let siteId: string;
  let W: string;
  let W2: string;
  let SUP: string;
  /** A supervisor of another site. */
  let SUP2: string;

  beforeAll(async () => {
    ctx = await startTestApp();
  });
  beforeEach(async () => {
    await ctx.reset();
    tenant = await createTenant(ctx.prisma);
    const orgId = tenant.organization.id;
    const [site, otherSite] = [
      await createSite(ctx.prisma, orgId),
      await createSite(ctx.prisma, orgId),
    ];
    siteId = site.id;
    const user = async (role: 'worker' | 'supervisor', site: string) => {
      const created = await createUser(ctx.prisma, orgId);
      await createMembership(ctx.prisma, orgId, created.id, role, { siteIds: [site] });
      return created.id;
    };
    W = await user('worker', site.id);
    W2 = await user('worker', site.id);
    SUP = await user('supervisor', site.id);
    SUP2 = await user('supervisor', otherSite.id);
  });
  afterAll(() => ctx.close());

  const as = (userId: string): ApiCaller => ctx.as(userId);
  const photo = (extra: Record<string, unknown> = {}) => ({
    fileName: 'pump.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    ...extra,
  });

  // `createdAt` a minute in the past: the clock is only ever moved forward from there.
  async function logOf(authorId: string, data: Record<string, unknown> = {}) {
    return ctx.prisma.workLog.create({
      data: {
        organizationId: tenant.organization.id,
        authorId,
        clientId: randomUUID(),
        occurredAt: at(),
        siteId,
        createdAt: new Date(Date.now() - 60_000),
        ...data,
      },
    });
  }

  async function start(userId: string, workLogId: string, extra: Record<string, unknown> = {}) {
    return as(userId).post(`/work-logs/${workLogId}/attachments`, photo(extra));
  }

  /** Starts, uploads `bytes` (a real JPEG by default) and completes, as `userId`. */
  async function uploadReady(userId: string, workLogId: string, bytes?: Uint8Array) {
    const body = bytes ?? (await makeJpeg());
    const started = await start(userId, workLogId, { sizeBytes: body.byteLength });
    expect(started.status).toBe(201);
    ctx.storage.uploadTo(started.body.upload.url, body);
    const completed = await as(userId).post(`/attachments/${started.body.attachment.id}/complete`);
    expect(completed.status).toBe(200);
    return { started, completed, id: started.body.attachment.id as string };
  }

  const storageKeyOf = async (id: string) =>
    (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } })).storageKey;

  describe('storage keys are chosen by the API', () => {
    it.each([
      ['a path in the file name', '../../org/other/work-logs/x/evil.jpg', 'image/jpeg', 'jpg'],
      ['an executable name declared as PNG', 'run.exe', 'image/png', 'png'],
      ['a name with a query and spaces', 'a b?c=d#e.jpeg', 'image/jpeg', 'jpg'],
      ['unicode', 'çatı fotoğrafı.png', 'image/png', 'png'],
    ])(
      '%s: org/<org>/work-logs/<log>/<uuid>.<ext>, nothing of the name',
      async (_n, fileName, mimeType, ext) => {
        const log = await logOf(W);
        const response = await start(W, log.id, { fileName, mimeType });
        expect(response.status).toBe(201);
        const key = await storageKeyOf(response.body.attachment.id);
        expect(key).toMatch(
          new RegExp(
            `^org/${tenant.organization.id}/work-logs/${log.id}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${ext}$`,
          ),
        );
        const stem = fileName.replace(/\.[^.]*$/, '');
        expect(key).not.toContain(stem);
        // The name is kept as metadata only (trimmed), for display and the download name.
        expect(response.body.attachment.fileName).toBe(fileName.trim());
      },
    );

    it('gives every upload its own key, even with the same file name on the same log', async () => {
      const log = await logOf(W);
      const keys = new Set<string>();
      for (let index = 0; index < 3; index += 1) {
        keys.add(await storageKeyOf((await start(W, log.id)).body.attachment.id));
      }
      expect(keys.size).toBe(3);
    });

    it('never puts a storage key in a response body field, an audit event or an outbox event', async () => {
      const log = await logOf(W);
      const responses: ApiResponse[] = [];
      const started = await start(W, log.id);
      responses.push(started);
      const id = started.body.attachment.id as string;
      responses.push(await as(W).post(`/attachments/${id}/upload-url`));
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      responses.push(await as(W).post(`/attachments/${id}/complete`));
      responses.push(await as(W).get(`/attachments/${id}`));
      responses.push(await as(W).get(`/work-logs/${log.id}/attachments`));
      responses.push(await as(W).get(`/work-logs/${log.id}`));
      responses.push(await as(W).post(`/attachments/${id}/archive`));
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } });

      // Only the signed URLs (which address the object by design) may contain the key.
      const withoutUrls = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(withoutUrls);
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => !['url', 'thumbnailUrl'].includes(key))
              .map(([key, inner]) => [key, withoutUrls(inner)]),
          );
        }
        return value;
      };
      for (const response of responses) {
        expect(response.status).toBeLessThan(300);
        const text = JSON.stringify(withoutUrls(response.body));
        expect(text).not.toContain(row.storageKey);
        expect(text).not.toContain('storageKey');
        expect(text).not.toContain('thumbnailKey');
      }
      const audit = JSON.stringify(await ctx.prisma.auditEvent.findMany());
      const outbox = JSON.stringify(
        await ctx.prisma.outboxEvent.findMany({ select: { eventType: true, payload: true } }),
      );
      for (const stored of [audit, outbox]) {
        expect(stored).not.toContain(row.storageKey);
        expect(stored).not.toContain('fake-storage');
        expect(stored).not.toContain('storageKey');
      }
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 3, outbox: 3 });
    });
  });

  describe('content checks', () => {
    it('refuses an image with too many pixels (422 too_many_pixels) and deletes the object', async () => {
      const log = await logOf(W);
      const bomb = pngHeaderClaiming(10_000, 10_000);
      const started = await start(W, log.id, { mimeType: 'image/png', sizeBytes: bomb.byteLength });
      const key = ctx.storage.uploadTo(started.body.upload.url, bomb);

      const completed = await as(W).post(`/attachments/${started.body.attachment.id}/complete`);

      expect(completed.status).toBe(422);
      expect(completed.body.details[0]).toEqual({ path: 'file', message: 'too_many_pixels' });
      expect(ctx.storage.objects.has(key)).toBe(false);
      expect(ctx.storage.deleted).toContain(key);
      expect(
        (
          await ctx.prisma.attachment.findUniqueOrThrow({
            where: { id: started.body.attachment.id },
          })
        ).status,
      ).toBe('pending');
    });

    it('deletes a stored object above UPLOAD_MAX_BYTES; the same attachment can then be uploaded again', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      const key = ctx.storage.uploadTo(
        started.body.upload.url,
        new Uint8Array(10 * 1024 * 1024 + 1),
      );

      const tooLarge = await as(W).post(`/attachments/${id}/complete`);
      expect(tooLarge.status).toBe(422);
      expect(ctx.storage.objects.has(key)).toBe(false);

      const renewed = await as(W).post(`/attachments/${id}/upload-url`);
      expect(renewed.status).toBe(200);
      ctx.storage.uploadTo(renewed.body.upload.url, await makeJpeg(20, 10));
      const completed = await as(W).post(`/attachments/${id}/complete`);
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({ status: 'ready', width: 20, height: 10 });
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 2, outbox: 2 });
    });

    it('a PNG renamed .jpg and declared as PNG is judged by its content, not its name', async () => {
      const log = await logOf(W);
      const png = await makePng(12, 8);
      const started = await start(W, log.id, {
        fileName: 'looks-like.jpg',
        mimeType: 'image/png',
        sizeBytes: png.byteLength,
      });
      ctx.storage.uploadTo(started.body.upload.url, png, 'image/jpeg');
      const completed = await as(W).post(`/attachments/${started.body.attachment.id}/complete`);
      expect(completed.status).toBe(200);
      expect(completed.body).toMatchObject({ mimeType: 'image/png', width: 12, height: 8 });
    });
  });

  describe('complete and renew', () => {
    it('complete is idempotent: repeated and concurrent calls make one ready attachment and one event', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());

      const responses = await Promise.all(
        [1, 2, 3].map(() => as(W).post(`/attachments/${id}/complete`)),
      );
      const again = await as(W).post(`/attachments/${id}/complete`);

      expect([...responses, again].map((response) => response.status)).toEqual([
        200, 200, 200, 200,
      ]);
      expect(new Set([...responses, again].map((response) => response.body.status))).toEqual(
        new Set(['ready']),
      );
      expect(
        await ctx.prisma.outboxEvent.count({ where: { eventType: 'attachment.completed' } }),
      ).toBe(1);
      expect(await ctx.prisma.auditEvent.count({ where: { action: 'attachment.completed' } })).toBe(
        1,
      );
    });

    it('renews only a pending attachment: 409 once archived, 409 once ready', async () => {
      const log = await logOf(W);
      const pending = (await start(W, log.id)).body.attachment.id as string;
      expect((await as(W).post(`/attachments/${pending}/archive`)).status).toBe(200);
      const archivedRenew = await as(W).post(`/attachments/${pending}/upload-url`);
      expect(archivedRenew.status).toBe(409);
      expect(archivedRenew.body.code).toBe('record_archived');
      // Completing an archived pending attachment is refused too, even with bytes in place.
      ctx.storage.upload(await storageKeyOf(pending), await makeJpeg());
      expect((await as(W).post(`/attachments/${pending}/complete`)).status).toBe(409);

      const { id: ready } = await uploadReady(W, log.id);
      expect((await as(W).post(`/attachments/${ready}/upload-url`)).status).toBe(409);
    });

    it('a renewed upload target points at the same key; no second attachment is created', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const renewed = await as(W).post(`/attachments/${started.body.attachment.id}/upload-url`);
      expect(FakeFileStorage.keyOf(renewed.body.upload.url)).toBe(
        await storageKeyOf(started.body.attachment.id),
      );
      expect(await ctx.prisma.attachment.count()).toBe(1);
      // Renewing records nothing: it changes no row.
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });
    });
  });

  describe('the per-log cap', () => {
    it(`allows exactly ${MAX_ATTACHMENTS_PER_WORK_LOG} under a concurrent burst; archived ones free a slot`, async () => {
      const log = await logOf(W);
      const responses = await Promise.all(
        Array.from({ length: MAX_ATTACHMENTS_PER_WORK_LOG + 5 }, () => start(W, log.id)),
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(
        MAX_ATTACHMENTS_PER_WORK_LOG,
      );
      expect(statuses.filter((status) => status === 409)).toHaveLength(5);
      expect(await ctx.prisma.attachment.count({ where: { workLogId: log.id } })).toBe(
        MAX_ATTACHMENTS_PER_WORK_LOG,
      );

      const first = responses.find((response) => response.status === 201)!;
      expect((await as(W).post(`/attachments/${first.body.attachment.id}/archive`)).status).toBe(
        200,
      );
      expect((await start(W, log.id)).status).toBe(201);
      expect((await start(W, log.id)).status).toBe(409);
    });

    it('counts per log: another log of the same author is not affected', async () => {
      const [full, empty] = [await logOf(W), await logOf(W)];
      for (let index = 0; index < MAX_ATTACHMENTS_PER_WORK_LOG; index += 1) {
        await ctx.prisma.attachment.create({
          data: {
            organizationId: tenant.organization.id,
            workLogId: full.id,
            uploadedById: W,
            fileName: `p${index}.jpg`,
            mimeType: 'image/jpeg',
            sizeBytes: 1,
            storageKey: `org/${tenant.organization.id}/work-logs/${full.id}/${randomUUID()}.jpg`,
          },
        });
      }
      expect((await start(W, full.id)).status).toBe(409);
      expect((await start(W, empty.id)).status).toBe(201);
    });
  });

  describe('who may add photos', () => {
    it('the author inside the edit window, on a submitted, draft or rejected log', async () => {
      for (const status of ['submitted', 'draft', 'rejected'] as const) {
        const log = await logOf(W, { status });
        expect([status, (await start(W, log.id)).status]).toEqual([status, 201]);
      }
    });

    it('not the author once the log is approved (409), nor after the edit window (403)', async () => {
      const approved = await logOf(W, { status: 'approved' });
      const refused = await start(W, approved.id);
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('already_reviewed');
      expect(refused.body.message).toBe('An approved work log cannot be changed by its author');

      const late = await logOf(W);
      ctx.clock.freeze(new Date(late.createdAt.getTime() + 24 * HOUR + 1));
      const lateStart = await start(W, late.id);
      expect(lateStart.status).toBe(403);
      // Not declared in the log's create request: not part of the original submission.
      expect(lateStart.body.code).toBe('attachment_not_declared');
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('a reviewer in scope, also on an approved log or after the window', async () => {
      const approved = await logOf(W, { status: 'approved' });
      const late = await logOf(W);
      ctx.clock.freeze(new Date(late.createdAt.getTime() + 48 * HOUR));
      expect((await start(SUP, approved.id)).status).toBe(201);
      expect((await start(SUP, late.id)).status).toBe(201);
      expect((await start(tenant.admin.id, late.id)).status).toBe(201);
    });

    it('nobody who cannot see the log (404): a colleague at the same site, a supervisor of another site', async () => {
      const log = await logOf(W);
      expect((await start(W2, log.id)).status).toBe(404);
      expect((await start(SUP2, log.id)).status).toBe(404);
      expect(await ctx.prisma.attachment.count()).toBe(0);
    });

    it('a supervisor on their own log follows the author rule (no self-review exception)', async () => {
      const own = await logOf(SUP, { status: 'approved' });
      expect((await start(SUP, own.id)).status).toBe(409);
    });

    // ADR-0008 fixed the Phase 4 limitation: an upload started inside the window can be renewed
    // and completed by its uploader for 30 days after its start, whatever the window.
    it('the author completes an upload started in the window after the window has closed', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      ctx.clock.freeze(new Date(log.createdAt.getTime() + 24 * HOUR + 1));
      const completed = await as(W).post(`/attachments/${started.body.attachment.id}/complete`);
      expect(completed.status).toBe(200);
      expect(completed.body.status).toBe('ready');
    });

    it('but not more than 30 days after the upload started (403 edit_window_closed)', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      ctx.clock.freeze(new Date(log.createdAt.getTime() + 31 * 24 * HOUR));
      const late = await as(W).post(`/attachments/${started.body.attachment.id}/complete`);
      expect(late.status).toBe(403);
      expect(late.body.code).toBe('edit_window_closed');
    });
  });

  describe("no access to another worker's photos", () => {
    it('another worker gets 404 for the attachment, its list, complete, renew and archive, and never a URL', async () => {
      const log = await logOf(W);
      const { id: ready } = await uploadReady(W, log.id);
      const pending = (await start(W, log.id)).body.attachment.id as string;
      ctx.storage.uploadTo(
        (await as(W).post(`/attachments/${pending}/upload-url`)).body.upload.url,
        await makeJpeg(),
      );

      const other = as(W2);
      const answers: ApiResponse[] = [];
      for (const id of [ready, pending]) {
        answers.push(await other.get(`/attachments/${id}`));
        answers.push(await other.post(`/attachments/${id}/complete`));
        answers.push(await other.post(`/attachments/${id}/upload-url`));
        answers.push(await other.post(`/attachments/${id}/archive`));
      }
      answers.push(await other.get(`/work-logs/${log.id}/attachments`));
      answers.push(await other.get(`/work-logs/${log.id}/attachments`, { includeArchived: true }));

      expect(answers.map((answer) => answer.status)).toEqual(Array(answers.length).fill(404));
      for (const answer of answers) {
        expect(answer.text).not.toContain('fake-storage');
        expect(answer.text).not.toContain('pump.jpg');
      }
      // Nothing changed: the pending one is still pending, nothing archived, no event.
      expect(
        (await ctx.prisma.attachment.findMany({ orderBy: { createdAt: 'asc' } })).map((row) => [
          row.status,
          row.archivedAt,
        ]),
      ).toEqual([
        ['ready', null],
        ['pending', null],
      ]);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 3, outbox: 3 });
    });

    it('a supervisor in scope sees ready photos with URLs, but not someone else’s pending ones', async () => {
      const log = await logOf(W);
      const { id: ready } = await uploadReady(W, log.id);
      const pending = (await start(W, log.id)).body.attachment.id as string;

      const list = await as(SUP).get(`/work-logs/${log.id}/attachments`);
      expect(list.status).toBe(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([ready]);
      expect(list.body.items[0].url).toMatch(/^fake-storage:\/\/download\//);
      expect(attachmentSchema.safeParse(list.body.items[0]).success).toBe(true);
      expect((await as(SUP).get(`/attachments/${ready}`)).body.thumbnailUrl).not.toBeNull();
      expect((await as(SUP).get(`/attachments/${pending}`)).status).toBe(404);
      // And the supervisor's own pending upload is invisible to the author.
      const theirs = (await start(SUP, log.id)).body.attachment.id as string;
      expect((await as(SUP).get(`/attachments/${theirs}`)).status).toBe(200);
      expect((await as(W).get(`/attachments/${theirs}`)).status).toBe(404);
      expect((await as(W).get(`/work-logs/${log.id}/attachments`)).body.total).toBe(2);
    });

    it('signs URLs only for a ready, not archived attachment (the uploader’s pending one has none)', async () => {
      const log = await logOf(W);
      const pending = await start(W, log.id);
      expect(pending.body.attachment).toMatchObject({
        url: null,
        thumbnailUrl: null,
        urlsExpireAt: null,
      });
      expect((await as(W).get(`/attachments/${pending.body.attachment.id}`)).body.url).toBeNull();

      const { id } = await uploadReady(W, log.id);
      const ready = await as(W).get(`/attachments/${id}`);
      expect(ready.body.url).not.toBeNull();
      expect(Date.parse(ready.body.urlsExpireAt)).toBeGreaterThan(Date.now());

      await as(SUP).post(`/attachments/${id}/archive`);
      for (const response of [
        await as(W).get(`/attachments/${id}`),
        await as(SUP).get(`/attachments/${id}`),
        await as(SUP).get(`/work-logs/${log.id}/attachments`, { includeArchived: true }),
      ]) {
        expect(response.status).toBe(200);
        expect(response.text).not.toContain('fake-storage://download');
      }
    });

    it('an archived work log keeps its photos readable but refuses new ones (409) to the author and a reviewer', async () => {
      const log = await logOf(W);
      const { id } = await uploadReady(W, log.id);
      expect((await as(W).post(`/work-logs/${log.id}/archive`)).status).toBe(200);
      expect((await start(W, log.id)).status).toBe(409);
      expect((await start(SUP, log.id)).status).toBe(409);
      expect((await as(SUP).get(`/attachments/${id}`)).status).toBe(200);
    });

    it('another organization never sees the photo (404), even its admin', async () => {
      const log = await logOf(W);
      const { id } = await uploadReady(W, log.id);
      const other = await createTenant(ctx.prisma, 'Elsewhere');
      const response = await as(other.admin.id).get(`/attachments/${id}`);
      expect(response.status).toBe(404);
      expect((await as(other.admin.id).get(`/work-logs/${log.id}/attachments`)).status).toBe(404);
      expect(
        (await as(other.admin.id).post(`/work-logs/${log.id}/attachments`, photo())).status,
      ).toBe(404);
    });
  });

  describe('storage unavailable', () => {
    it('answers 503 for start and records nothing; for complete it keeps the attachment pending', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      ctx.storage.fail = true;

      expect((await start(W, log.id)).status).toBe(503);
      expect((await as(W).post(`/attachments/${started.body.attachment.id}/complete`)).status).toBe(
        503,
      );
      expect(await ctx.prisma.attachment.count()).toBe(1);
      expect(await eventCounts(ctx.prisma)).toEqual({ audit: 1, outbox: 1 });

      ctx.storage.fail = false;
      expect((await as(W).post(`/attachments/${started.body.attachment.id}/complete`)).status).toBe(
        200,
      );
    });
  });

  describe('the served original is a re-encoded copy under a key no client can write', () => {
    /** The bytes the signed `url` of a response points at. */
    const served = (response: ApiResponse): Uint8Array => {
      const object = ctx.storage.objects.get(FakeFileStorage.keyOf(response.body.url as string));
      if (!object) throw new Error('nothing stored at the served key');
      return object.body;
    };

    it('a PUT to the old upload URL after complete does not change what url serves', async () => {
      const log = await logOf(W);
      const original = await makeJpeg(40, 30);
      const started = await start(W, log.id, { sizeBytes: original.byteLength });
      const id = started.body.attachment.id as string;
      const uploadKey = ctx.storage.uploadTo(started.body.upload.url, original);
      const completed = await as(W).post(`/attachments/${id}/complete`);
      expect(completed.status).toBe(200);
      const servedKey = FakeFileStorage.keyOf(completed.body.url as string);
      expect(servedKey).not.toBe(uploadKey);
      expect(servedKey).toBe(uploadKey.replace(/\.jpg$/, '') + servedKey.slice(-22));
      expect(servedKey).toMatch(/\.[0-9a-f]{8}\.verified\.jpg$/);
      expect(FakeFileStorage.keyOf(completed.body.thumbnailUrl as string)).toBe(
        `${servedKey}.thumb.jpg`,
      );
      // The upload object is deleted after the commit; no upload URL ever named the served key.
      expect(ctx.storage.objects.has(uploadKey)).toBe(false);
      expect(ctx.storage.uploads.map((upload) => upload.storageKey)).not.toContain(servedKey);
      const before = served(completed);

      // The author PUTs other bytes of the same length to the still valid upload URL.
      ctx.storage.uploadTo(started.body.upload.url, new Uint8Array(original.byteLength).fill(7));

      const fetched = await as(SUP).get(`/attachments/${id}`);
      expect(FakeFileStorage.keyOf(fetched.body.url as string)).toBe(servedKey);
      expect(served(fetched)).toEqual(before);
      // Completing again changes nothing.
      const again = await as(W).post(`/attachments/${id}/complete`);
      expect(FakeFileStorage.keyOf(again.body.url as string)).toBe(servedKey);
      expect(served(again)).toEqual(before);
    });

    it('EXIF in the upload (camera, GPS, orientation) is gone from the served file; size and dimensions are those of the served file', async () => {
      const log = await logOf(W);
      const tagged = new Uint8Array(
        await sharp({
          create: { width: 80, height: 60, channels: 3, background: { r: 9, g: 9, b: 9 } },
        })
          .jpeg()
          .withExif({ IFD0: { Make: 'TellTaleCam' }, IFD3: { GPSLatitudeRef: 'N' } })
          .withMetadata({ orientation: 6 })
          .toBuffer(),
      );
      expect(Buffer.from(tagged).includes('TellTaleCam')).toBe(true);
      const { completed, id } = await uploadReady(W, log.id, tagged);
      const bytes = served(completed);
      const metadata = await sharp(Buffer.from(bytes)).metadata();
      expect(metadata.exif).toBeUndefined();
      expect(metadata.orientation).toBeUndefined();
      expect(Buffer.from(bytes).includes('TellTaleCam')).toBe(false);
      expect([metadata.width, metadata.height]).toEqual([60, 80]);
      expect(completed.body).toMatchObject({ width: 60, height: 80, sizeBytes: bytes.byteLength });
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } });
      expect(row.sizeBytes).toBe(bytes.byteLength);
    });

    it('a JPEG with data appended after the image is served without it', async () => {
      const log = await logOf(W);
      const polyglot = new Uint8Array([
        ...(await makeJpeg(30, 20)),
        ...new TextEncoder().encode('<html><script>alert(1)</script></html>'),
      ]);
      const { completed } = await uploadReady(W, log.id, polyglot);
      const bytes = Buffer.from(served(completed));
      expect(bytes.includes('<script>')).toBe(false);
      expect((await sharp(bytes).metadata()).format).toBe('jpeg');
    });

    it('a completion that loses to an archive leaves no verified copy behind', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      const uploadKey = ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      const processor = ctx.app.get(ImageProcessor);
      const realVerify = processor.verify.bind(processor);
      const spy = jest.spyOn(processor, 'verify').mockImplementation(async (bytes, declared) => {
        const result = await realVerify(bytes, declared);
        // The archive commits while the image is being re-encoded.
        await ctx.prisma.attachment.update({ where: { id }, data: { archivedAt: new Date() } });
        return result;
      });
      try {
        expect((await as(W).post(`/attachments/${id}/complete`)).status).toBe(409);
      } finally {
        spy.mockRestore();
      }
      expect([...ctx.storage.objects.keys()]).toEqual([uploadKey]);
    });
  });

  describe('per-user limits and decoding', () => {
    it(`start: 429 rate_limited with Retry-After after ${UPLOAD_RATE_LIMITS.start.limit} in the window, per user`, async () => {
      const logs = [(await logOf(W)).id, (await logOf(W)).id, (await logOf(W)).id];
      for (let index = 0; index < UPLOAD_RATE_LIMITS.start.limit; index += 1) {
        expect((await start(W, logs[index % logs.length]!)).status).not.toBe(429);
      }
      const limited = await start(W, (await logOf(W)).id);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      // Another user is not affected; a new window starts after the old one.
      expect((await start(SUP, (await logOf(W)).id)).status).toBe(201);
      ctx.clock.freeze(new Date(Date.now() + UPLOAD_RATE_LIMITS.start.windowSeconds * 1000 + 1));
      expect((await start(W, (await logOf(W, { createdAt: ctx.clock.now() })).id)).status).toBe(
        201,
      );
    });

    it(`renew and complete: 429 after ${UPLOAD_RATE_LIMITS.complete.limit} calls each`, async () => {
      const log = await logOf(W);
      const pending = (await start(W, log.id)).body.attachment.id as string;
      for (let index = 0; index < UPLOAD_RATE_LIMITS.renew.limit; index += 1) {
        expect((await as(W).post(`/attachments/${pending}/upload-url`)).status).toBe(200);
      }
      const renewLimited = await as(W).post(`/attachments/${pending}/upload-url`);
      expect(renewLimited.status).toBe(429);
      expect(Number(renewLimited.headers.get('retry-after'))).toBeGreaterThan(0);

      const { id } = await uploadReady(W, log.id);
      for (let index = 1; index < UPLOAD_RATE_LIMITS.complete.limit; index += 1) {
        expect((await as(W).post(`/attachments/${id}/complete`)).status).toBe(200);
      }
      const limited = await as(W).post(`/attachments/${id}/complete`);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe('rate_limited');
    });

    it('concurrent completes of one attachment decode the image once', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg(200, 150));
      const spy = jest.spyOn(ctx.app.get(ImageProcessor), 'verify');
      try {
        const responses = await Promise.all(
          Array.from({ length: 5 }, () => as(W).post(`/attachments/${id}/complete`)),
        );
        expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
        expect(responses.every((response) => typeof response.body.url === 'string')).toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      // One verified copy and one thumbnail; the upload object is gone.
      expect(ctx.storage.objects.size).toBe(2);
    });

    it('answers 503 when no decode slot frees up in time, and keeps the attachment pending', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      const spy = jest
        .spyOn(ctx.app.get(ImageProcessor), 'verify')
        .mockRejectedValueOnce(new ConcurrencyLimitTimeoutError(30_000));
      try {
        const busy = await as(W).post(`/attachments/${id}/complete`);
        expect(busy.status).toBe(503);
        expect(busy.body.code).toBe('service_unavailable');
      } finally {
        spy.mockRestore();
      }
      expect((await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } })).status).toBe(
        'pending',
      );
      expect((await as(W).post(`/attachments/${id}/complete`)).status).toBe(200);
    });
  });

  describe('purge of archived pending uploads', () => {
    const TTL_MS = 300_000; // UPLOAD_URL_TTL_SECONDS of the test configuration

    it('deletes the bytes of a pending attachment archived longer ago than the upload URL lifetime, idempotently', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      expect((await as(W).post(`/attachments/${id}/archive`)).status).toBe(200);
      // A PUT through the still valid URL after the archive.
      const key = ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      const { id: ready } = await uploadReady(W, log.id);
      expect((await as(W).post(`/attachments/${ready}/archive`)).status).toBe(200);
      const readyRow = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: ready } });
      const archivedAt = (await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } }))
        .archivedAt!;
      const cleanup = ctx.app.get(AttachmentCleanupService);
      const events = await eventCounts(ctx.prisma);

      // Not while the upload URL may still be valid.
      expect(
        await cleanup.purgeArchivedPendingUploads(new Date(archivedAt.getTime() + TTL_MS - 1000)),
      ).toBe(0);
      expect(ctx.storage.objects.has(key)).toBe(true);

      const after = new Date(archivedAt.getTime() + TTL_MS + 1000);
      expect(await cleanup.purgeArchivedPendingUploads(after)).toBe(1);
      expect(ctx.storage.objects.has(key)).toBe(false);
      // Again: harmless (the object is already gone).
      expect(await cleanup.purgeArchivedPendingUploads(after)).toBe(1);
      // A ready attachment, even archived, keeps its files; no row changed, nothing recorded.
      expect(ctx.storage.objects.has(readyRow.storageKey)).toBe(true);
      expect(ctx.storage.objects.has(readyRow.thumbnailKey!)).toBe(true);
      expect(await eventCounts(ctx.prisma)).toEqual(events);
      // Long after, the row is no longer looked at.
      expect(
        await cleanup.purgeArchivedPendingUploads(
          new Date(archivedAt.getTime() + TTL_MS + (PURGE_RETRY_HOURS + 1) * HOUR),
        ),
      ).toBe(0);
    });

    it('also purges uploads the expiry archived, and stops at a storage failure', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const cleanup = ctx.app.get(AttachmentCleanupService);
      const expiredAt = new Date(Date.now() + 25 * HOUR);
      expect(await cleanup.expireStaleUploads(expiredAt)).toBe(1);
      const key = ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      const purgeAt = new Date(expiredAt.getTime() + TTL_MS + 1);
      ctx.storage.fail = true;
      await expect(cleanup.purgeArchivedPendingUploads(purgeAt)).rejects.toThrow();
      ctx.storage.fail = false;
      expect(await cleanup.purgeArchivedPendingUploads(purgeAt)).toBe(1);
      expect(ctx.storage.objects.has(key)).toBe(false);
    });
  });

  describe('cleanup of abandoned uploads', () => {
    const later = () => new Date(Date.now() + 25 * HOUR);

    it('deletes the object of an expired pending upload and archives it with attachment.upload_expired', async () => {
      const log = await logOf(W);
      const stale = await start(W, log.id);
      const staleKey = ctx.storage.uploadTo(stale.body.upload.url, await makeJpeg());
      const { id: ready } = await uploadReady(W, log.id);
      const readyKey = await storageKeyOf(ready);
      const cleanup = ctx.app.get(AttachmentCleanupService);

      expect(await cleanup.expireStaleUploads(new Date(Date.now() + 23 * HOUR))).toBe(0);
      expect(await cleanup.expireStaleUploads(later())).toBe(1);

      expect(ctx.storage.objects.has(staleKey)).toBe(false);
      expect(ctx.storage.deleted).toContain(staleKey);
      expect(ctx.storage.deleted).not.toContain(readyKey);
      expect(ctx.storage.objects.has(readyKey)).toBe(true);
      const rows = await ctx.prisma.attachment.findMany({ orderBy: { createdAt: 'asc' } });
      expect(rows.map((row) => [row.status, row.archivedAt !== null])).toEqual([
        ['pending', true],
        ['ready', false],
      ]);
      const event = await ctx.prisma.outboxEvent.findFirstOrThrow({
        where: { eventType: 'attachment.upload_expired' },
      });
      expect(event).toMatchObject({ aggregateId: stale.body.attachment.id, actorId: null });
      expect(JSON.stringify(event.payload)).not.toContain(staleKey);
      const audit = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'attachment.upload_expired' },
      });
      expect(audit.actorType).toBe('system');

      // Running again changes nothing; the client can no longer complete or renew it.
      expect(await cleanup.expireStaleUploads(later())).toBe(0);
      expect((await as(W).post(`/attachments/${stale.body.attachment.id}/complete`)).status).toBe(
        409,
      );
      expect((await as(W).post(`/attachments/${stale.body.attachment.id}/upload-url`)).status).toBe(
        409,
      );
    });

    it('expires a pending upload whose bytes never arrived', async () => {
      const log = await logOf(W);
      await start(W, log.id);
      expect(await ctx.app.get(AttachmentCleanupService).expireStaleUploads(later())).toBe(1);
    });

    it('stops at a storage failure and archives nothing (retried on the next run)', async () => {
      const log = await logOf(W);
      await start(W, log.id);
      await start(W, log.id);
      ctx.storage.fail = true;
      await expect(
        ctx.app.get(AttachmentCleanupService).expireStaleUploads(later()),
      ).rejects.toThrow();
      expect(await ctx.prisma.attachment.count({ where: { archivedAt: { not: null } } })).toBe(0);
      ctx.storage.fail = false;
      expect(await ctx.app.get(AttachmentCleanupService).expireStaleUploads(later())).toBe(2);
    });

    // The cleanup claims the attachment (archives it while still pending) BEFORE deleting its
    // file, so a phone that completes at that moment is refused instead of ending up with a READY
    // attachment whose file is gone. Simulated by completing inside the delete.
    it('never leaves a ready attachment without its file when a completion races the cleanup', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      const key = ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      const realDelete = ctx.storage.delete.bind(ctx.storage);
      let raced: number | undefined;
      ctx.storage.delete = async (storageKey: string) => {
        if (storageKey === key) {
          // A phone that comes back after a day finishes its upload at this very moment.
          raced = (await as(W).post(`/attachments/${id}/complete`)).status;
        }
        return realDelete(storageKey);
      };
      try {
        await ctx.app.get(AttachmentCleanupService).expireStaleUploads(later());
      } finally {
        ctx.storage.delete = realDelete;
      }
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } });
      expect(raced).toBe(409);
      expect(row.status).toBe('pending');
      expect(row.archivedAt).not.toBeNull();
      expect(ctx.storage.objects.has(key)).toBe(false);
    });

    it('a completion that commits before the cleanup claims the row keeps the photo', async () => {
      const log = await logOf(W);
      const started = await start(W, log.id);
      const id = started.body.attachment.id as string;
      ctx.storage.uploadTo(started.body.upload.url, await makeJpeg());
      expect((await as(W).post(`/attachments/${id}/complete`)).status).toBe(200);
      expect(await ctx.app.get(AttachmentCleanupService).expireStaleUploads(later())).toBe(0);
      const row = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('ready');
      expect(ctx.storage.objects.has(row.storageKey)).toBe(true);
      expect(ctx.storage.objects.has(row.thumbnailKey!)).toBe(true);
    });
  });
});
