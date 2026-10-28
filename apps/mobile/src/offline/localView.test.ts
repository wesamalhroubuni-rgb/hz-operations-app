import { findWorkLog, viewTasks, viewWorkLogs } from './localView';
import { at, createBody, memoryLayer, ORG, T0, task, USER_A, workLog } from './storeTestKit';

const user = { id: USER_A, organizationId: ORG };

describe('optimistic local view', () => {
  it('shows a queued create as a pending log known by its clientId, with later edits applied', async () => {
    const { queue } = memoryLayer();
    await queue.enqueue(
      { kind: 'createWorkLog', body: createBody({ clientId: 'c1', text: 'a' }) },
      T0,
    );
    const sent = (await queue.list())[0]!;
    await queue.markSending(sent.id, T0);
    await queue.enqueue(
      { kind: 'updateWorkLog', workLogClientId: 'c1', body: { text: 'b' } },
      at(1),
    );
    const view = viewWorkLogs([], await queue.list(), user);
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      id: 'c1',
      clientId: 'c1',
      authorId: USER_A,
      organizationId: ORG,
      text: 'b',
      status: 'submitted',
      submittedOffline: true,
      createdAt: T0.toISOString(),
    });
    expect(findWorkLog(view, 'c1')?.text).toBe('b');
  });

  it('applies queued edits and status changes to cached logs; once synced the server copy shows', async () => {
    const { queue } = memoryLayer();
    const cached = workLog({ id: 'l1', clientId: 'c1', status: 'rejected', text: 'old' });
    await queue.enqueue(
      { kind: 'updateWorkLog', workLogClientId: 'c1', body: { text: 'fixed' } },
      T0,
    );
    await queue.enqueue(
      { kind: 'changeWorkLogStatus', workLogClientId: 'c1', body: { status: 'submitted' } },
      at(1),
    );
    const [view] = viewWorkLogs([cached], await queue.list(), user);
    expect(view).toMatchObject({ id: 'l1', text: 'fixed', status: 'submitted' });
    // Found by the clientId the screen may still hold after the sync.
    expect(findWorkLog([cached], 'c1')?.id).toBe('l1');
  });

  it('a permanently refused edit is not shown on the log (the server version is), a refused create still is', async () => {
    const { queue } = memoryLayer();
    const cached = workLog({ id: 'l1', clientId: 'c1', text: 'server' });
    const editItem = await queue.enqueue(
      { kind: 'updateWorkLog', workLogClientId: 'c1', body: { text: 'mine' } },
      T0,
    );
    await queue.markFailed(
      editItem.item.id,
      { code: 'already_reviewed', message: 'x', status: 409 },
      true,
      null,
      T0,
    );
    const createItem = await queue.enqueue(
      { kind: 'createWorkLog', body: createBody({ clientId: 'c2' }) },
      T0,
    );
    await queue.markFailed(
      createItem.item.id,
      { code: 'occurred_at_out_of_range', message: 'x', status: 422 },
      true,
      null,
      T0,
    );
    const view = viewWorkLogs([cached], await queue.list(), user);
    expect(view.map((log) => [log.id, log.text])).toEqual([
      ['l1', 'server'],
      ['c2', 'New offline log'],
    ]);
  });

  it('applies queued task status changes', async () => {
    const { queue } = memoryLayer();
    await queue.enqueue(
      {
        kind: 'changeTaskStatus',
        taskId: 'task-1',
        body: { status: 'blocked', reason: 'No parts' },
      },
      T0,
    );
    const [view] = viewTasks([task()], await queue.list());
    expect(view).toMatchObject({ status: 'blocked', statusReason: 'No parts' });
    await queue.enqueue(
      { kind: 'changeTaskStatus', taskId: 'task-1', body: { status: 'done' } },
      at(1),
    );
    expect(viewTasks([task()], await queue.list())[0]).toMatchObject({
      status: 'done',
      statusReason: null,
      completedAt: at(1).toISOString(),
    });
  });
});
