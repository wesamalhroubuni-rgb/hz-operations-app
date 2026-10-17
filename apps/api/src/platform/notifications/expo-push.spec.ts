import {
  ExpoPushError,
  HttpExpoPushClient,
  maskPushToken,
  maskTokensIn,
  type ExpoPushClient,
  type ExpoPushMessage,
  type ExpoPushReceipt,
  type ExpoPushTicket,
} from './expo-push-client';
import { ExpoPushChannel, isInvalidTokenError } from './expo-push.channel';
import type { DeliverableNotification } from './notification-channel';
import type { PushTokenRow, PushTokenService } from './push-tokens.service';

// The Expo push client (with a fake fetch) and the push channel (with a fake client and a fake
// token store). Nothing here reaches the network. Example values only.

const TOKEN_A = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaa11]';
const TOKEN_B = 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbb22]';

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function message(to: string): ExpoPushMessage {
  return { to, title: 'Title', body: 'Body' };
}

describe('HttpExpoPushClient', () => {
  it('posts the messages to /push/send with the access token and returns the tickets', async () => {
    const fetchStub = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse(200, { data: [{ status: 'ok', id: 'ticket-1' }] })),
    );
    const client = new HttpExpoPushClient({
      accessToken: 'expo-access-example',
      fetch: fetchStub as unknown as typeof fetch,
    });
    const tickets = await client.send([message(TOKEN_A)]);
    expect(tickets).toEqual([{ status: 'ok', id: 'ticket-1' }]);
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(url).toBe('https://exp.host/--/api/v2/push/send');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer expo-access-example',
    );
    expect(JSON.parse(init.body as string)).toEqual([message(TOKEN_A)]);
  });

  it('sends no Authorization header without an access token', async () => {
    const fetchStub = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse(200, { data: [{ status: 'ok', id: 't' }] })),
    );
    await new HttpExpoPushClient({ fetch: fetchStub as unknown as typeof fetch }).send([
      message(TOKEN_A),
    ]);
    expect(
      (fetchStub.mock.calls[0]![1].headers as Record<string, string>).Authorization,
    ).toBeUndefined();
  });

  it('retries 429 and 5xx with backoff (honouring Retry-After), then succeeds', async () => {
    const answers = [
      jsonResponse(429, {}, { 'Retry-After': '2' }),
      jsonResponse(503, {}),
      jsonResponse(200, { data: [{ status: 'ok', id: 't' }] }),
    ];
    const fetchStub = jest.fn(() => Promise.resolve(answers.shift()!));
    const sleeps: number[] = [];
    const client = new HttpExpoPushClient({
      fetch: fetchStub as unknown as typeof fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await client.send([message(TOKEN_A)]);
    expect(fetchStub).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([2000, 1000]);
  });

  it('gives up after the retries with an ExpoPushError', async () => {
    const fetchStub = jest.fn(() => Promise.resolve(jsonResponse(502, {})));
    const client = new HttpExpoPushClient({
      fetch: fetchStub as unknown as typeof fetch,
      maxRetries: 1,
      sleep: () => Promise.resolve(),
    });
    await expect(client.send([message(TOKEN_A)])).rejects.toMatchObject({
      name: 'ExpoPushError',
      status: 502,
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure or timeout, and reports it without details', async () => {
    const fetchStub = jest.fn(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    const client = new HttpExpoPushClient({
      fetch: fetchStub as unknown as typeof fetch,
      maxRetries: 2,
      sleep: () => Promise.resolve(),
    });
    await expect(client.send([message(TOKEN_A)])).rejects.toThrow(
      'The Expo push service could not be reached (TimeoutError)',
    );
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 400 and surfaces the Expo error codes', async () => {
    const fetchStub = jest.fn(() =>
      Promise.resolve(
        jsonResponse(400, { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'x' }] }),
      ),
    );
    const client = new HttpExpoPushClient({ fetch: fetchStub as unknown as typeof fetch });
    const error = (await client.send([message(TOKEN_A)]).catch((e: unknown) => e)) as ExpoPushError;
    expect(error).toBeInstanceOf(ExpoPushError);
    expect(error.codes).toEqual(['PUSH_TOO_MANY_EXPERIENCE_IDS']);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer whose ticket count does not match', async () => {
    const fetchStub = jest.fn(() => Promise.resolve(jsonResponse(200, { data: [] })));
    const client = new HttpExpoPushClient({ fetch: fetchStub as unknown as typeof fetch });
    await expect(client.send([message(TOKEN_A)])).rejects.toBeInstanceOf(ExpoPushError);
  });

  it('refuses more than 100 messages per request', async () => {
    const client = new HttpExpoPushClient({ fetch: jest.fn() as unknown as typeof fetch });
    await expect(client.send(Array.from({ length: 101 }, () => message(TOKEN_A)))).rejects.toThrow(
      RangeError,
    );
  });

  it('reads receipts from /push/getReceipts', async () => {
    const fetchStub = jest.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(jsonResponse(200, { data: { t1: { status: 'ok' } } })),
    );
    const client = new HttpExpoPushClient({ fetch: fetchStub as unknown as typeof fetch });
    expect(await client.getReceipts(['t1', 't2'])).toEqual({ t1: { status: 'ok' } });
    expect(fetchStub.mock.calls[0]![0]).toBe('https://exp.host/--/api/v2/push/getReceipts');
    expect(JSON.parse(fetchStub.mock.calls[0]![1].body as string)).toEqual({ ids: ['t1', 't2'] });
  });
});

describe('token masking', () => {
  it('keeps only the last six characters', () => {
    expect(maskPushToken(TOKEN_A)).toBe('…aaaa11');
    expect(maskTokensIn(`"${TOKEN_B}" is not a registered push notification recipient`)).toBe(
      '"…bbbb22" is not a registered push notification recipient',
    );
  });

  it('recognises the errors that mean the token is dead', () => {
    expect(isInvalidTokenError(undefined, { error: 'DeviceNotRegistered' })).toBe(true);
    expect(isInvalidTokenError(`"${TOKEN_A}" is not a valid Expo push token`)).toBe(true);
    expect(isInvalidTokenError('Message too big', { error: 'MessageTooBig' })).toBe(false);
  });
});

class FakeExpoClient implements ExpoPushClient {
  readonly sent: ExpoPushMessage[][] = [];
  ticketsFor: (message: ExpoPushMessage, index: number) => ExpoPushTicket = (_m, index) => ({
    status: 'ok',
    id: `ticket-${this.sent.length - 1}-${index}`,
  });
  receipts: Record<string, ExpoPushReceipt> = {};
  receiptCalls: string[][] = [];
  failSend = false;

  send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    if (this.failSend) {
      return Promise.reject(new Error(`network down for ${messages[0]?.to}`));
    }
    this.sent.push([...messages]);
    return Promise.resolve(messages.map((m, index) => this.ticketsFor(m, index)));
  }

  getReceipts(ticketIds: readonly string[]): Promise<Record<string, ExpoPushReceipt>> {
    this.receiptCalls.push([...ticketIds]);
    return Promise.resolve(this.receipts);
  }
}

function tokenRow(id: string, userId: string, token: string, organizationId = 'org'): PushTokenRow {
  return {
    id,
    organizationId,
    userId,
    sessionId: `session-${id}`,
    token,
    platform: 'android',
    createdAt: new Date(0),
    lastSeenAt: new Date(0),
  };
}

function notification(recipientId: string, organizationId = 'org'): DeliverableNotification {
  return {
    id: `n-${recipientId}`,
    organizationId,
    recipientId,
    type: 'task.assigned',
    title: 'New task: Fix the pump',
    body: 'You have been assigned a task.',
    data: { taskId: 'task-1' },
    createdAt: new Date(0),
  };
}

function channel(rows: PushTokenRow[], options: { enabled?: boolean } = {}) {
  const client = new FakeExpoClient();
  const removed: string[] = [];
  const tokens = {
    deliverableTokens: jest.fn((userIds: readonly string[]) =>
      Promise.resolve(rows.filter((row) => userIds.includes(row.userId))),
    ),
    removeInvalid: jest.fn((id: string) => {
      removed.push(id);
      return Promise.resolve();
    }),
  };
  const clock = { now: 0 };
  const push = new ExpoPushChannel(tokens as unknown as PushTokenService, client, {
    enabled: options.enabled ?? true,
    receiptDelayMs: 1000,
    receiptMaxAgeMs: 10_000,
    now: () => clock.now,
  });
  return { push, client, tokens, removed, clock };
}

describe('ExpoPushChannel', () => {
  it('does nothing when disabled', async () => {
    const { push, client, tokens } = channel([tokenRow('t1', 'u1', TOKEN_A)], { enabled: false });
    await push.deliver([notification('u1')]);
    expect(client.sent).toEqual([]);
    expect(tokens.deliverableTokens).not.toHaveBeenCalled();
  });

  it('sends one message per live token with only title, body and ids', async () => {
    const { push, client } = channel([
      tokenRow('t1', 'u1', TOKEN_A),
      tokenRow('t2', 'u1', TOKEN_B),
      tokenRow('t3', 'u2', 'ExponentPushToken[cccccccccccccccccccc33]'),
    ]);
    const summary = await push.send([notification('u1')]);
    expect(summary).toEqual({ messages: 2, accepted: 2, failed: 0, removedTokens: 0 });
    expect(client.sent[0]).toEqual([
      {
        to: TOKEN_A,
        title: 'New task: Fix the pump',
        body: 'You have been assigned a task.',
        data: { taskId: 'task-1', notificationId: 'n-u1', type: 'task.assigned' },
        sound: 'default',
        priority: 'high',
      },
      expect.objectContaining({ to: TOKEN_B }),
    ]);
    expect(push.pendingReceiptCount).toBe(2);
  });

  it('uses the push text instead of the in-app title and body when the notification has one', async () => {
    const { push, client } = channel([tokenRow('t1', 'u1', TOKEN_A)]);
    await push.send([
      {
        ...notification('u1'),
        title: 'Work log rejected',
        body: 'Your work log was rejected: wrong site, redo the photos',
        push: { title: 'Work log rejected', body: 'Open the app for the reason.' },
      },
    ]);
    expect(client.sent[0]).toEqual([
      expect.objectContaining({
        to: TOKEN_A,
        title: 'Work log rejected',
        body: 'Open the app for the reason.',
      }),
    ]);
    expect(JSON.stringify(client.sent)).not.toContain('wrong site');
  });

  it('never pushes a notification of one organization to a token now bound to another', async () => {
    const { push, client } = channel([tokenRow('t1', 'u1', TOKEN_A, 'other-org')]);
    await push.send([notification('u1')]);
    expect(client.sent).toEqual([]);
  });

  it('sends in batches of at most 100', async () => {
    const rows = Array.from({ length: 150 }, (_, index) =>
      tokenRow(`t${index}`, 'u1', `ExponentPushToken[token${String(index).padStart(4, '0')}]`),
    );
    const { push, client } = channel(rows);
    await push.send([notification('u1')]);
    expect(client.sent.map((batch) => batch.length)).toEqual([100, 50]);
  });

  it('removes a token whose ticket says DeviceNotRegistered and keeps the others', async () => {
    const { push, client, removed } = channel([
      tokenRow('t1', 'u1', TOKEN_A),
      tokenRow('t2', 'u1', TOKEN_B),
    ]);
    client.ticketsFor = (m, index) =>
      m.to === TOKEN_A
        ? {
            status: 'error',
            message: `"${TOKEN_A}" is not a registered push notification recipient`,
            details: { error: 'DeviceNotRegistered' },
          }
        : { status: 'ok', id: `ticket-${index}` };
    const summary = await push.send([notification('u1')]);
    expect(summary).toMatchObject({ accepted: 1, failed: 1, removedTokens: 1 });
    expect(removed).toEqual(['t1']);
  });

  it('keeps the token on other ticket errors', async () => {
    const { push, client, removed } = channel([tokenRow('t1', 'u1', TOKEN_A)]);
    client.ticketsFor = () => ({
      status: 'error',
      message: 'rate',
      details: { error: 'MessageRateExceeded' },
    });
    await push.send([notification('u1')]);
    expect(removed).toEqual([]);
  });

  it('survives a failed batch (logged, nothing thrown)', async () => {
    const { push, client } = channel([tokenRow('t1', 'u1', TOKEN_A)]);
    client.failSend = true;
    await expect(push.send([notification('u1')])).resolves.toMatchObject({ failed: 1 });
  });

  it('checks receipts only once they are due, and removes DeviceNotRegistered tokens', async () => {
    const { push, client, removed, clock } = channel([
      tokenRow('t1', 'u1', TOKEN_A),
      tokenRow('t2', 'u1', TOKEN_B),
    ]);
    await push.send([notification('u1')]);
    const [first, second] = client.sent[0]!.map((_m, index) => `ticket-0-${index}`);
    clock.now = 500;
    expect(await push.checkReceipts()).toBe(0);
    expect(client.receiptCalls).toEqual([]);

    clock.now = 1000;
    client.receipts = {
      [first!]: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      // the second receipt is not ready yet
    };
    expect(await push.checkReceipts()).toBe(1);
    expect(removed).toEqual(['t1']);
    expect(push.pendingReceiptCount).toBe(1);

    client.receipts = { [second!]: { status: 'ok' } };
    await push.checkReceipts();
    expect(push.pendingReceiptCount).toBe(0);
  });

  it('forgets a ticket whose receipt never arrives', async () => {
    const { push, clock } = channel([tokenRow('t1', 'u1', TOKEN_A)]);
    await push.send([notification('u1')]);
    clock.now = 10_000;
    await push.checkReceipts();
    expect(push.pendingReceiptCount).toBe(0);
  });
});
