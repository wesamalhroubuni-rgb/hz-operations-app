import type { AuthTokens, AuthUser } from '../platform/auth.js';
import { isFormValid, newPasswordProblem, validateSignInForm } from './auth-forms.js';
import {
  AUTH_FAILURE_MESSAGES,
  type AuthFailureReason,
  type AuthSessionNotice,
} from './auth-text.js';
import type { ApiFailure, ApiResult } from './client.js';
import { createApiClient, type ApiClient } from './create-api-client.js';

/**
 * Where the mobile app keeps its bearer tokens between launches (Expo SecureStore). The session
 * manager is the only caller. Implementations may reject; the manager copes.
 */
export interface TokenStorage {
  load(): Promise<AuthTokens | null>;
  save(tokens: AuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export type AuthState =
  /** The stored session is being checked. Show neither the sign-in form nor protected content. */
  | { status: 'loading' }
  | { status: 'signedOut'; notice: AuthSessionNotice | null }
  | { status: 'signedIn'; user: AuthUser };

export const INITIAL_AUTH_STATE: AuthState = { status: 'loading' };

export interface AuthActionFailure {
  reason: AuthFailureReason;
  /** Ready to show. Never contains a password, a code or a token. */
  message: string;
  /** Extra lines for `weak_password`: what the server did not accept about the password. */
  details: string[];
}

export type AuthActionResult = { ok: true } | { ok: false; failure: AuthActionFailure };

interface CommonAuthSessionManagerOptions {
  baseUrl: string;
  /** Defaults to the global fetch. Pass a stub in tests. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Only for a deployment where one identifier may exist in several organizations. */
  organizationSlug?: string;
}

export type AuthSessionManagerOptions = CommonAuthSessionManagerOptions &
  (
    | {
        /**
         * The session lives in httpOnly cookies the page cannot read. The manager keeps only the
         * CSRF token and the user, in memory.
         */
        mode: 'web';
      }
    | {
        /** Bearer tokens, in memory and in `storage`. */
        mode: 'mobile';
        storage: TokenStorage;
        /** A label the user will recognise in their list of sessions. */
        deviceName?: string;
      }
  );

export interface AuthSessionManager {
  /** The typed API client of the app. Every request carries the session and renews it on a 401. */
  client: ApiClient;
  getState(): AuthState;
  /** Calls the listener after every state change. Returns the function that unsubscribes. */
  subscribe(listener: () => void): () => void;
  /**
   * Finds out whether a session exists (and, on mobile, loads the stored tokens first). Call it
   * once when the app starts, and again to retry after the `unreachable` notice. Calls made while
   * one is running share it.
   */
  start(): Promise<void>;
  signIn(identifier: string, password: string): Promise<AuthActionResult>;
  /** Ends the session of this device. Always leaves the app signed out. */
  signOut(): Promise<AuthActionResult>;
  /** Ends every session of the user. Stays signed in when the server could not confirm it. */
  signOutEverywhere(): Promise<AuthActionResult>;
  /** Activation and password reset. Does not sign in: the user signs in afterwards. */
  setPassword(code: string, password: string): Promise<AuthActionResult>;
}

function failed(reason: AuthFailureReason, details: string[] = []): AuthActionResult {
  return { ok: false, failure: { reason, message: AUTH_FAILURE_MESSAGES[reason], details } };
}

function isStatus(result: ApiResult<unknown>, status: number): boolean {
  return !result.ok && result.failure.kind === 'http' && result.failure.status === status;
}

/** What every action has in common: no answer, too many attempts, anything else. */
function commonReason(failure: ApiFailure): AuthFailureReason {
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    return 'network';
  }
  if (
    failure.kind === 'http' &&
    (failure.status === 429 || failure.error.code === 'rate_limited')
  ) {
    return 'rate_limited';
  }
  return 'unexpected';
}

/**
 * Why a sign-in failed. The API answers a wrong password, an unknown, locked, archived or
 * not-yet-activated account all alike, and so does this: one reason, one message.
 */
export function signInFailureReason(failure: ApiFailure): AuthFailureReason {
  const common = commonReason(failure);
  if (common !== 'unexpected') {
    return common;
  }
  // 401 is the API's one answer to every failed sign-in. 400 is an identifier or password it
  // will not even look up (too long, for example). 403 is something else: the API refuses the
  // origin of the page (CORS_ORIGINS), which no retyping will fix, so it is not reported as
  // wrong details.
  if (failure.kind === 'http' && [400, 401].includes(failure.status)) {
    return 'invalid_credentials';
  }
  return 'unexpected';
}

/** The API words a detail as a predicate ("is too common"); make it a sentence. */
function passwordSentence(message: string): string {
  const text = message.trim();
  return `The password ${text}${/[.!?]$/.test(text) ? '' : '.'}`;
}

/**
 * Why setting a password failed, with the server's remarks about the password, if any. The API
 * answers 422 for a code that is unknown, used or expired, and 400 with details on `password`
 * for a password its policy refuses (the code is not used up by that).
 */
export function setPasswordFailure(failure: ApiFailure): AuthActionFailure {
  let reason = commonReason(failure);
  let details: string[] = [];
  // 403 is a refused origin, not a bad code.
  if (
    reason === 'unexpected' &&
    failure.kind === 'http' &&
    failure.status < 500 &&
    failure.status !== 403
  ) {
    // Remarks about the password describe the rule that was broken and never repeat the password.
    details = (failure.error.details ?? [])
      .filter((detail) => detail.path === 'password' || detail.path.startsWith('password.'))
      .map((detail) => passwordSentence(detail.message));
    reason = details.length > 0 ? 'weak_password' : 'invalid_code';
  }
  return { reason, message: AUTH_FAILURE_MESSAGES[reason], details };
}

/**
 * A refresh that failed with one of these means the session is gone. Anything else (no answer,
 * 429, 5xx, a refused origin) says nothing about the session, so it is kept.
 */
function sessionIsGone(failure: ApiFailure): boolean {
  return failure.kind === 'http' && [400, 401].includes(failure.status);
}

type RefreshOutcome = 'renewed' | 'gone' | 'unreachable' | 'superseded';

/**
 * The sign-in state of one app, and the API client bound to it. Framework-free: the React
 * providers of the web and mobile apps only subscribe to it.
 *
 * It never logs, and never puts a password, a one-time code or a token in a message.
 */
export function createAuthSessionManager(options: AuthSessionManagerOptions): AuthSessionManager {
  const storage = options.mode === 'mobile' ? options.storage : null;
  const listeners = new Set<() => void>();
  let state: AuthState = INITIAL_AUTH_STATE;
  /** Mobile only. */
  let tokens: AuthTokens | null = null;
  /** Web only. */
  let csrfToken: string | null = null;
  // Incremented whenever the session is replaced or dropped, so an answer that belongs to an
  // earlier session can be recognised and ignored.
  let epoch = 0;
  let refreshing: Promise<boolean> | null = null;
  let lastRefresh: RefreshOutcome = 'renewed';
  let starting: Promise<void> | null = null;

  const client = createApiClient({
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    // `omit` on mobile: the session is the bearer token alone, never a cookie jar.
    credentials: options.mode === 'web' ? 'include' : 'omit',
    auth: {
      getAccessToken: () => tokens?.accessToken ?? null,
      getCsrfToken: () => csrfToken,
      refresh,
      onAuthLost,
    },
  });

  function setState(next: AuthState): void {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  }

  /** Storage failures must not break the session in memory. One retry, then carry on. */
  async function persist(next: AuthTokens): Promise<void> {
    if (storage === null) {
      return;
    }
    try {
      await storage.save(next);
    } catch {
      try {
        await storage.save(next);
      } catch {
        // The session keeps working from memory until the app is closed.
      }
    }
  }

  async function forget(): Promise<void> {
    tokens = null;
    csrfToken = null;
    if (storage !== null) {
      try {
        await storage.clear();
      } catch {
        // Nothing more can be done here; the tokens were revoked or are about to expire.
      }
    }
  }

  /** One refresh at a time, whoever asks: the transport after a 401, or `signOut`. */
  function refresh(): Promise<boolean> {
    refreshing ??= renew()
      .catch(() => {
        lastRefresh = 'unreachable';
        return false;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  /** Mobile names its session by refresh token, so sign-out works with an expired access token. */
  function logoutBody(): { refreshToken: string } | undefined {
    return tokens === null ? undefined : { refreshToken: tokens.refreshToken };
  }

  async function renew(): Promise<boolean> {
    const startedIn = epoch;
    if (storage !== null && tokens === null) {
      lastRefresh = 'gone';
      return false;
    }
    const result = await client.auth.refresh(
      tokens === null ? {} : { refreshToken: tokens.refreshToken },
    );
    if (startedIn !== epoch) {
      // The user signed out, or in again, while this was on its way.
      lastRefresh = 'superseded';
      return false;
    }
    if (!result.ok) {
      lastRefresh = sessionIsGone(result.failure) ? 'gone' : 'unreachable';
      return false;
    }
    if (storage === null) {
      csrfToken = result.data.csrfToken;
      lastRefresh = 'renewed';
      return true;
    }
    const rotated = result.data.tokens;
    if (rotated === null) {
      lastRefresh = 'gone';
      return false;
    }
    // The old refresh token is used up the moment the server answers. Write the new pair to
    // storage first and only then start using it, so storage is never behind memory: if the app
    // dies after this line, the next launch finds the pair that works.
    await persist(rotated);
    if (startedIn !== epoch) {
      // Signed out during the write: do not leave tokens behind.
      await forget();
      lastRefresh = 'superseded';
      return false;
    }
    tokens = rotated;
    lastRefresh = 'renewed';
    return true;
  }

  /** The transport could not renew the session (or got a second 401 right after renewing it). */
  function onAuthLost(): void {
    if (lastRefresh === 'superseded') {
      return;
    }
    if (lastRefresh === 'unreachable') {
      // Nothing proves the session is gone, so nothing is thrown away. The failed request
      // reports its own error, and the next one tries to renew again.
      return;
    }
    if (state.status === 'signedOut') {
      // An earlier failed request already signed out; keep the notice it set.
      return;
    }
    const hadSession = state.status === 'signedIn' || tokens !== null;
    epoch += 1;
    void forget();
    setState({ status: 'signedOut', notice: hadSession ? 'session_expired' : null });
  }

  async function runStart(): Promise<void> {
    epoch += 1;
    const startedIn = epoch;
    setState(INITIAL_AUTH_STATE);

    if (storage !== null) {
      try {
        tokens = await storage.load();
      } catch {
        tokens = null;
      }
      if (startedIn !== epoch) {
        return;
      }
      if (tokens === null) {
        setState({ status: 'signedOut', notice: null });
        return;
      }
    }

    // An expired access token is renewed by the transport on the way (one refresh, one repeat).
    const result = await client.auth.me();
    if (startedIn !== epoch || state.status !== 'loading') {
      // Superseded, or `onAuthLost` already settled it.
      return;
    }
    if (result.ok) {
      if (storage === null) {
        csrfToken = result.data.csrfToken;
      }
      setState({ status: 'signedIn', user: result.data.user });
      return;
    }
    // No usable answer. Stored tokens are kept: the session may well be alive.
    setState({ status: 'signedOut', notice: 'unreachable' });
  }

  return {
    client,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    start() {
      starting ??= runStart().finally(() => {
        starting = null;
      });
      return starting;
    },

    async signIn(identifier, password) {
      if (!isFormValid(validateSignInForm({ identifier, password }))) {
        return failed('missing_fields');
      }
      epoch += 1;
      const startedIn = epoch;
      const result = await client.auth.login({
        identifier: identifier.trim(),
        password,
        client: options.mode,
        ...(options.organizationSlug ? { organizationSlug: options.organizationSlug } : {}),
        ...(options.mode === 'mobile' && options.deviceName
          ? { deviceName: options.deviceName }
          : {}),
      });
      if (!result.ok) {
        return failed(signInFailureReason(result.failure));
      }
      if (startedIn !== epoch) {
        return failed('unexpected');
      }
      if (storage === null) {
        csrfToken = result.data.csrfToken;
      } else {
        if (result.data.tokens === null) {
          return failed('unexpected');
        }
        await persist(result.data.tokens);
        tokens = result.data.tokens;
      }
      setState({ status: 'signedIn', user: result.data.user });
      return { ok: true };
    },

    async signOut() {
      let result = await client.auth.logout(logoutBody());
      let confirmed = result.ok;
      if (isStatus(result, 401)) {
        // The access token had expired, so the server did not see who is signing out. Renew once
        // and say it again; without this the refresh cookie or token would outlive the sign-out.
        if (await refresh()) {
          result = await client.auth.logout(logoutBody());
          confirmed = result.ok || isStatus(result, 401);
        } else {
          confirmed = lastRefresh === 'gone';
        }
      }
      epoch += 1;
      await forget();
      setState({ status: 'signedOut', notice: confirmed ? null : 'sign_out_unconfirmed' });
      return { ok: true };
    },

    async signOutEverywhere() {
      const result = await client.auth.logoutAll();
      if (!result.ok) {
        if (state.status === 'signedOut') {
          // The session turned out to be gone already; `onAuthLost` has cleaned up.
          return { ok: true };
        }
        // Claiming success here would be dangerous: the other devices are still signed in.
        return failed(commonReason(result.failure));
      }
      epoch += 1;
      await forget();
      setState({ status: 'signedOut', notice: null });
      return { ok: true };
    },

    async setPassword(code, password) {
      if (code.trim() === '') {
        return failed('invalid_code');
      }
      const problem = newPasswordProblem(password);
      if (problem !== null) {
        return { ok: false, failure: { reason: 'weak_password', message: problem, details: [] } };
      }
      const result = await client.auth.setPassword({ code: code.trim(), password });
      return result.ok ? { ok: true } : { ok: false, failure: setPasswordFailure(result.failure) };
    },
  };
}
