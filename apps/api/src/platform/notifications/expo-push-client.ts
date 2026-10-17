/**
 * The HTTP client of Expo's push service (reusable platform component), behind an interface so
 * tests use a fake and no real push is ever sent from a test.
 *
 * Expo push API (https://docs.expo.dev/push-notifications/sending-notifications/):
 * - `POST https://exp.host/--/api/v2/push/send` with a JSON array of at most 100 messages. The
 *   answer is `{ data: [ticket, ...] }`, one ticket per message IN THE SAME ORDER: either
 *   `{ status: 'ok', id }` (accepted; `id` is used to fetch the receipt) or
 *   `{ status: 'error', message, details: { error: 'DeviceNotRegistered' | ... } }`. A request
 *   that fails as a whole answers `{ errors: [{ code, message }] }`.
 * - `POST https://exp.host/--/api/v2/push/getReceipts` with `{ ids: [...] }` (at most 1000).
 *   The answer is `{ data: { [id]: receipt } }`; a receipt says whether Apple or Google accepted
 *   the message, e.g. `{ status: 'error', details: { error: 'DeviceNotRegistered' } }`. Receipts
 *   appear some minutes after sending and are kept for about a day.
 * - `Authorization: Bearer <EXPO_ACCESS_TOKEN>` is required only when "enhanced push security"
 *   is enabled for the project; it is sent whenever a token is configured.
 *
 * Plain `fetch` (Node 24), no SDK: two JSON endpoints do not justify a dependency.
 *
 * Retries: a 429 or 5xx answer, or a network failure, is retried up to `maxRetries` times with
 * exponential backoff (honouring `Retry-After`, capped at 10 s). Each attempt has a timeout.
 * A retried `send` after a network failure can, rarely, deliver a message twice; that is
 * preferred to losing it. Nothing here logs a push token or a message body.
 */

export interface ExpoPushMessage {
  /** The Expo push token, `ExponentPushToken[...]`. */
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  sound?: 'default' | null;
  priority?: 'default' | 'normal' | 'high';
  /** Android notification channel; omitted means the app's default channel. */
  channelId?: string;
}

export interface ExpoErrorDetails {
  /** `DeviceNotRegistered`, `MessageTooBig`, `MessageRateExceeded`, `InvalidCredentials`, ... */
  error?: string;
  expoPushToken?: string;
}

export type ExpoPushTicket =
  { status: 'ok'; id: string } | { status: 'error'; message?: string; details?: ExpoErrorDetails };

export type ExpoPushReceipt =
  { status: 'ok' } | { status: 'error'; message?: string; details?: ExpoErrorDetails };

export interface ExpoPushClient {
  /** Sends at most `EXPO_MAX_MESSAGES_PER_REQUEST` messages; one ticket per message, in order. */
  send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  /** Receipts of at most `EXPO_MAX_RECEIPT_IDS_PER_REQUEST` tickets; missing ids are not ready. */
  getReceipts(ticketIds: readonly string[]): Promise<Record<string, ExpoPushReceipt>>;
}

export const EXPO_PUSH_CLIENT = Symbol('platform.expoPushClient');

export const EXPO_PUSH_BASE_URL = 'https://exp.host/--/api/v2';
export const EXPO_MAX_MESSAGES_PER_REQUEST = 100;
export const EXPO_MAX_RECEIPT_IDS_PER_REQUEST = 1000;

/** Expo refused a request as a whole (after retries), or answered something unreadable. */
export class ExpoPushError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Expo's error codes, e.g. `PUSH_TOO_MANY_EXPERIENCE_IDS`. */
    readonly codes: string[] = [],
  ) {
    super(message);
    this.name = 'ExpoPushError';
  }
}

export interface HttpExpoPushClientOptions {
  accessToken?: string;
  baseUrl?: string;
  /** Timeout of one attempt. Default 10 s. */
  timeoutMs?: number;
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** Base of the backoff. Default 500 ms. */
  retryBaseMs?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
}

const MAX_BACKOFF_MS = 10_000;

/** A push token reduced to its last characters, for logs and the audit trail. */
export function maskPushToken(token: string): string {
  const inner = /\[([^\]]*)\]$/.exec(token)?.[1] ?? token;
  return `…${inner.slice(-6)}`;
}

/** Replaces every Expo push token inside a text (Expo's error messages quote them). */
export function maskTokensIn(text: string): string {
  return text.replace(/Expo(nent)?PushToken\[[^\]]*\]/g, (token) => maskPushToken(token));
}

function retryAfterMs(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCodes(body: unknown): string[] {
  if (!isRecord(body) || !Array.isArray(body.errors)) {
    return [];
  }
  return body.errors.map((item: unknown) =>
    isRecord(item) && typeof item.code === 'string' ? item.code : 'UNKNOWN',
  );
}

export class HttpExpoPushClient implements ExpoPushClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: HttpExpoPushClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? EXPO_PUSH_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
    if (messages.length === 0) {
      return [];
    }
    if (messages.length > EXPO_MAX_MESSAGES_PER_REQUEST) {
      throw new RangeError(`At most ${EXPO_MAX_MESSAGES_PER_REQUEST} messages per request`);
    }
    const body = await this.post('/push/send', messages);
    if (!isRecord(body) || !Array.isArray(body.data) || body.data.length !== messages.length) {
      throw new ExpoPushError(
        'Unexpected answer from the Expo push service',
        200,
        errorCodes(body),
      );
    }
    return body.data as ExpoPushTicket[];
  }

  async getReceipts(ticketIds: readonly string[]): Promise<Record<string, ExpoPushReceipt>> {
    if (ticketIds.length === 0) {
      return {};
    }
    if (ticketIds.length > EXPO_MAX_RECEIPT_IDS_PER_REQUEST) {
      throw new RangeError(`At most ${EXPO_MAX_RECEIPT_IDS_PER_REQUEST} receipt ids per request`);
    }
    const body = await this.post('/push/getReceipts', { ids: ticketIds });
    if (!isRecord(body) || !isRecord(body.data)) {
      throw new ExpoPushError(
        'Unexpected answer from the Expo push service',
        200,
        errorCodes(body),
      );
    }
    return body.data as Record<string, ExpoPushReceipt>;
  }

  private async post(path: string, payload: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate',
      'Content-Type': 'application/json',
    };
    if (this.options.accessToken) {
      headers.Authorization = `Bearer ${this.options.accessToken}`;
    }
    const text = JSON.stringify(payload);
    for (let attempt = 0; ; attempt += 1) {
      const canRetry = attempt < this.maxRetries;
      const backoff = Math.min(this.retryBaseMs * 2 ** attempt, MAX_BACKOFF_MS);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: text,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (canRetry) {
          await this.sleep(backoff);
          continue;
        }
        const name = (error as { name?: unknown } | null)?.name;
        const reason = typeof name === 'string' ? name : 'Error';
        throw new ExpoPushError(`The Expo push service could not be reached (${reason})`, null);
      }
      if ((response.status === 429 || response.status >= 500) && canRetry) {
        await response.text().catch(() => '');
        const wait = retryAfterMs(response.headers.get('retry-after'));
        await this.sleep(Math.min(wait ?? backoff, MAX_BACKOFF_MS));
        continue;
      }
      const raw = await response.text().catch(() => '');
      let body: unknown;
      try {
        body = raw === '' ? null : JSON.parse(raw);
      } catch {
        body = null;
      }
      if (!response.ok) {
        const codes = errorCodes(body);
        throw new ExpoPushError(
          `The Expo push service answered ${response.status}` +
            (codes.length > 0 ? ` (${codes.join(', ')})` : ''),
          response.status,
          codes,
        );
      }
      if (isRecord(body) && Array.isArray(body.errors) && body.data === undefined) {
        const codes = errorCodes(body);
        throw new ExpoPushError(
          `The Expo push service refused the request (${codes.join(', ')})`,
          response.status,
          codes,
        );
      }
      return body;
    }
  }
}
