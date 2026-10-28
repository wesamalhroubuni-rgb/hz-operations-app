import { memoryLayer, photo, T0, workLog } from '../offline/storeTestKit';
import { createUploadsView, isPhotoOfLog, uploadErrorKindOf } from './uploadQueue';

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('uploads view over the write queue', () => {
  it('shows queued photos with their log, status, progress and error kind', async () => {
    const layer = memoryLayer();
    await layer.store.upsert('workLogs', [workLog({ id: 'l1', clientId: 'c1' })]);
    const view = createUploadsView({ queue: layer.queue, store: layer.store });
    const { item } = await layer.queue.enqueue(
      {
        kind: 'uploadAttachment',
        workLogClientId: 'c1',
        workLogId: null,
        attachmentClientId: 'a1',
        photo: photo('p1'),
        checkpoint: { attachmentId: null, stored: false },
      },
      T0,
    );
    await settle();
    expect(view.getState().items).toMatchObject([
      { itemId: item.id, workLogId: 'l1', workLogClientId: 'c1', status: 'waiting', progress: 0 },
    ]);

    await layer.queue.markSending(item.id, T0);
    layer.queue.setProgress(item.id, 0.5);
    await settle();
    expect(view.getState().items[0]).toMatchObject({ status: 'uploading', progress: 0.5 });

    await layer.queue.markFailed(
      item.id,
      { code: 'edit_window_closed', message: 'x', status: 403 },
      true,
      null,
      T0,
    );
    await settle();
    expect(view.getState().items[0]).toMatchObject({ status: 'failed', error: 'notAllowed' });

    view.retry('c1');
    await settle();
    expect((await layer.queue.get(item.id))?.state).toBe('pending');

    await view.discard('p1');
    await settle();
    expect(view.getState().items).toEqual([]);
    view.dispose();
  });

  it('maps error codes to the screen’s kinds and matches a log by either id', () => {
    expect(uploadErrorKindOf({ code: 'timeout', message: '', status: null })).toBe('network');
    expect(uploadErrorKindOf({ code: 'attachment_not_declared', message: '', status: 403 })).toBe(
      'notAllowed',
    );
    expect(uploadErrorKindOf({ code: 'not_found', message: '', status: 404 })).toBe('notFound');
    expect(uploadErrorKindOf({ code: 'validation_failed', message: '', status: 400 })).toBe(
      'rejected',
    );
    expect(uploadErrorKindOf({ code: 'photo_missing', message: '', status: null })).toBe(
      'unexpected',
    );
    const queued = { workLogId: 'l1', workLogClientId: 'c1' } as Parameters<typeof isPhotoOfLog>[0];
    expect(isPhotoOfLog(queued, 'l1')).toBe(true);
    expect(isPhotoOfLog(queued, 'c1')).toBe(true);
    expect(isPhotoOfLog(queued, 'other')).toBe(false);
  });
});
