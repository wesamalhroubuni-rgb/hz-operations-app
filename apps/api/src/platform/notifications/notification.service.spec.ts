import type { PrismaService } from '../../prisma/prisma.service';
import type { DeliverableNotification, NotificationChannel } from './notification-channel';
import { NotificationService } from './notification.service';

// Writing notifications: active recipients only, idempotent per source event, delivery after
// the write and only for new rows, a failing channel never reaching the caller.
// A fake database with the unique key (sourceEventId, recipientId, type). Example values only.

interface Row extends DeliverableNotification {
  sourceEventId: string | null;
}

function fakeDb(activeUsers: Array<{ id: string; organizationId: string }>) {
  const rows: Row[] = [];
  let counter = 0;
  return {
    rows,
    user: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] }; organizationId: string } }) =>
        Promise.resolve(
          activeUsers
            .filter((u) => where.id.in.includes(u.id) && u.organizationId === where.organizationId)
            .map((u) => ({ id: u.id })),
        ),
      ),
    },
    notification: {
      createManyAndReturn: jest.fn(({ data }: { data: Array<Omit<Row, 'id' | 'createdAt'>> }) => {
        const inserted: Row[] = [];
        for (const item of data) {
          const duplicate =
            item.sourceEventId !== null &&
            rows.some(
              (row) =>
                row.sourceEventId === item.sourceEventId &&
                row.recipientId === item.recipientId &&
                row.type === item.type,
            );
          if (!duplicate) {
            counter += 1;
            const row = { ...item, id: `n${counter}`, createdAt: new Date(0) };
            rows.push(row);
            inserted.push(row);
          }
        }
        return Promise.resolve(inserted);
      }),
    },
  };
}

class RecordingChannel implements NotificationChannel {
  readonly name = 'recording';
  readonly batches: string[][] = [];
  deliver(notifications: readonly DeliverableNotification[]): Promise<void> {
    this.batches.push(notifications.map((n) => n.recipientId));
    return Promise.resolve();
  }
}

const INPUT = {
  organizationId: 'org',
  type: 'task.assigned',
  title: 'New task: Fix the pump',
  body: 'You have been assigned a task.',
  data: { taskId: 'task-1' },
  sourceEventId: 'event-1',
};

describe('NotificationService', () => {
  it('writes one row per active recipient of the organization and skips the others', async () => {
    const db = fakeDb([
      { id: 'deniz', organizationId: 'org' },
      { id: 'stranger', organizationId: 'other-org' },
    ]);
    const channel = new RecordingChannel();
    const service = new NotificationService(db as unknown as PrismaService, [channel]);
    const result = await service.notify({
      ...INPUT,
      recipientIds: ['deniz', 'deniz', 'stranger', 'archived'],
    });
    await service.whenIdle();
    expect(result.created.map((n) => n.recipientId)).toEqual(['deniz']);
    expect(result.skippedRecipientIds).toEqual(['stranger', 'archived']);
    expect(channel.batches).toEqual([['deniz']]);
  });

  it('is idempotent per source event: a second call writes and delivers nothing', async () => {
    const db = fakeDb([{ id: 'deniz', organizationId: 'org' }]);
    const channel = new RecordingChannel();
    const service = new NotificationService(db as unknown as PrismaService, [channel]);
    await service.notify({ ...INPUT, recipientIds: ['deniz'] });
    const again = await service.notify({ ...INPUT, recipientIds: ['deniz'] });
    await service.whenIdle();
    expect(again.created).toEqual([]);
    expect(db.rows).toHaveLength(1);
    expect(channel.batches).toEqual([['deniz']]);
  });

  it('does not wait for the channels, and a failing channel never reaches the caller', async () => {
    const db = fakeDb([{ id: 'deniz', organizationId: 'org' }]);
    let release: () => void = () => undefined;
    const slow: NotificationChannel = {
      name: 'slow',
      deliver: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    };
    const broken: NotificationChannel = {
      name: 'broken',
      deliver: () => Promise.reject(new Error('push service down')),
    };
    const service = new NotificationService(db as unknown as PrismaService, [slow, broken]);
    const result = await service.notify({ ...INPUT, recipientIds: ['deniz'] });
    expect(result.created).toHaveLength(1);
    release();
    await expect(service.whenIdle()).resolves.toBeUndefined();
  });

  it('writes in the caller transaction without delivering', async () => {
    const db = fakeDb([{ id: 'deniz', organizationId: 'org' }]);
    const channel = new RecordingChannel();
    const service = new NotificationService({} as PrismaService, [channel]);
    const result = await service.notifyInTransaction(db, { ...INPUT, recipientIds: ['deniz'] });
    await service.whenIdle();
    expect(channel.batches).toEqual([]);
    service.deliver(result.created);
    await service.whenIdle();
    expect(channel.batches).toEqual([['deniz']]);
  });

  it('clips an over-long title and body', async () => {
    const db = fakeDb([{ id: 'deniz', organizationId: 'org' }]);
    const service = new NotificationService(db as unknown as PrismaService, []);
    const result = await service.notify({
      ...INPUT,
      recipientIds: ['deniz'],
      title: 'x'.repeat(500),
      body: 'y'.repeat(5000),
    });
    expect(result.created[0]!.title).toHaveLength(200);
    expect(result.created[0]!.body).toHaveLength(2000);
  });

  it('touches nothing without recipients', async () => {
    const db = fakeDb([]);
    const service = new NotificationService(db as unknown as PrismaService, []);
    expect(await service.notify({ ...INPUT, recipientIds: [] })).toEqual({
      created: [],
      skippedRecipientIds: [],
    });
    expect(db.user.findMany).not.toHaveBeenCalled();
  });
});
