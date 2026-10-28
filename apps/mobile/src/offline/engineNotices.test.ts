import { createMemoryStore } from '../storage/keyValueStore';
import { droppedReferencesOf } from './engine';
import {
  createDroppedReferenceNotices,
  DROPPED_REFERENCES_MAX_ENTRIES,
  droppedReferencesKey,
} from './engineNotices';
import { createHarness, testUuid } from './engineTestKit';

// The app's AsyncStorage store is not used here (the tests pass a memory store).
jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: {} }));

describe('droppedReferencesOf', () => {
  it('lists the links sent with the create that the accepted log lacks', () => {
    expect(
      droppedReferencesOf(
        { taskId: 'a', siteId: 'b', teamId: null },
        { taskId: null, siteId: 'b', teamId: null },
      ),
    ).toEqual(['taskId']);
    expect(
      droppedReferencesOf({ taskId: undefined }, { taskId: null, siteId: null, teamId: null }),
    ).toEqual([]);
  });
});

describe('the engine reports dropped links of an offline create', () => {
  it('calls onDroppedReferences after the log is cached', async () => {
    const seen: string[][] = [];
    const h = createHarness({
      onDroppedReferences: (_log, fields) => {
        seen.push(fields);
      },
    });
    const clientId = testUuid();
    await h.queue.enqueue(
      {
        kind: 'createWorkLog',
        body: {
          clientId,
          text: 'x',
          occurredAt: '2026-10-27T08:00:00.000Z',
          taskId: testUuid(),
          siteId: testUuid(),
        } as never,
      },
      new Date('2026-10-27T10:00:00.000Z'),
    );
    // The server stores the log without the task (reassigned meanwhile), keeps the site.
    h.api.interceptor = null;
    const create = h.api.client.workLogs.create;
    h.api.client.workLogs.create = async (body, options) => {
      const result = await create({ ...body, taskId: null }, options);
      return result;
    };

    await h.engine.syncNow('manual');

    expect(seen).toEqual([['taskId']]);
  });
});

describe('dropped-reference notices', () => {
  const now = new Date('2026-10-27T10:00:00.000Z');

  it('keeps the fields per log, per user', async () => {
    const kv = createMemoryStore();
    const notices = createDroppedReferenceNotices(kv, 'user-1', () => now);
    const listener = jest.fn();
    notices.subscribe(listener);
    await notices.record('log-a', ['taskId'], now);
    expect(await notices.get('log-a')).toEqual(['taskId']);
    expect(await notices.get('log-b')).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(Object.keys(kv.dump())).toEqual([droppedReferencesKey('user-1')]);
    expect(await createDroppedReferenceNotices(kv, 'user-2', () => now).get('log-a')).toBeNull();
  });

  it('forgets entries after 30 days and keeps at most the newest 200', async () => {
    const kv = createMemoryStore();
    let clock = now;
    const notices = createDroppedReferenceNotices(kv, 'user-1', () => clock);
    await notices.record('old', ['siteId'], now);
    clock = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
    expect(await notices.get('old')).toBeNull();
    for (let index = 0; index <= DROPPED_REFERENCES_MAX_ENTRIES; index += 1) {
      await notices.record(`log-${index}`, ['teamId'], new Date(clock.getTime() + index));
    }
    expect(await notices.get('log-0')).toBeNull();
    expect(await notices.get(`log-${DROPPED_REFERENCES_MAX_ENTRIES}`)).toEqual(['teamId']);
  });
});
