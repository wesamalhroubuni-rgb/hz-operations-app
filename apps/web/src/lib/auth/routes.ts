import type { AuthState } from '@ops/shared';

export const LOGIN_PATH = '/login';
export const ACTIVATE_PATH = '/activate';
export const HOME_PATH = '/';

/** Query parameter of /login that remembers where the user was going. */
export const NEXT_PARAM = 'next';
/** Query parameter of /login that announces something that just happened. */
export const NOTICE_PARAM = 'notice';
export const PASSWORD_SET_NOTICE = 'password-set';
/** Query parameter of /activate carrying the one-time code of an activation or reset link. */
export const CODE_PARAM = 'code';

/** Routes that work without a session. Every other route is protected. */
const PUBLIC_PATHS: readonly string[] = [LOGIN_PATH, ACTIVATE_PATH];

function normalise(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? HOME_PATH : trimmed;
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.includes(normalise(pathname));
}

const MAX_REDIRECT_LENGTH = 2048;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Turns whatever arrived in `?next=` into a path that is safe to navigate to, or `/`.
 *
 * Only a relative path on this origin is accepted, which is what prevents an open redirect: a
 * link such as `/login?next=https://evil.example` or `?next=//evil.example` must not send a user
 * who has just typed their password to another site. Sending them back to the sign-in or
 * activation page would be a loop, so those are refused too.
 */
export function sanitizeRedirectPath(value: string | null | undefined): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REDIRECT_LENGTH) {
    return HOME_PATH;
  }
  // One leading slash exactly: `//host` and `/\host` are other origins to a browser.
  if (!value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) {
    return HOME_PATH;
  }
  // Backslashes and control characters (tab, newline) are rewritten or stripped by browsers
  // before the URL is parsed, which is how `/\t/evil.example` becomes `//evil.example`.
  if (value.includes('\\') || hasControlCharacter(value)) {
    return HOME_PATH;
  }
  let url: URL;
  try {
    url = new URL(value, 'http://same-origin.invalid');
  } catch {
    return HOME_PATH;
  }
  if (url.origin !== 'http://same-origin.invalid' || isPublicPath(url.pathname)) {
    return HOME_PATH;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The sign-in URL that returns to `path` (pathname plus query) afterwards. */
export function loginPathFor(path: string): string {
  const next = sanitizeRedirectPath(path);
  return next === HOME_PATH
    ? LOGIN_PATH
    : `${LOGIN_PATH}?${NEXT_PARAM}=${encodeURIComponent(next)}`;
}

export type GuardView =
  /** Show the page. */
  | 'content'
  /** Show the neutral loading state: the session is being checked or a redirect is under way. */
  | 'loading';

/**
 * What to show for a route in a sign-in state. A protected route shows its content only to a
 * signed-in user: while the session is being checked, and while the redirect to the sign-in page
 * is under way, it shows the loading state, so protected content never flashes.
 *
 * This is a convenience for the user, not a security control. The page's JavaScript is public
 * and anyone can skip this check; what protects the data is the API, which authenticates and
 * authorises every request.
 */
export function guardView(status: AuthState['status'], pathname: string): GuardView {
  const path = normalise(pathname);
  if (!isPublicPath(path)) {
    return status === 'signedIn' ? 'content' : 'loading';
  }
  if (path === LOGIN_PATH) {
    // A signed-in user is sent on, so the form is shown only once we know nobody is signed in.
    return status === 'signedOut' ? 'content' : 'loading';
  }
  // The activation form needs no session and no answer about one.
  return 'content';
}

/**
 * Where to send the user instead, or null to stay. `search` is the query string of the current
 * URL (`window.location.search`).
 */
export function guardRedirect(
  status: AuthState['status'],
  pathname: string,
  search: string,
): string | null {
  const path = normalise(pathname);
  if (status === 'signedOut' && !isPublicPath(path)) {
    return loginPathFor(`${path}${search}`);
  }
  if (status === 'signedIn' && path === LOGIN_PATH) {
    return sanitizeRedirectPath(new URLSearchParams(search).get(NEXT_PARAM));
  }
  return null;
}
