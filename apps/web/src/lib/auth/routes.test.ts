import { describe, expect, it } from 'vitest';

import {
  guardRedirect,
  guardView,
  isPublicPath,
  loginPathFor,
  sanitizeRedirectPath,
} from './routes';

describe('sanitizeRedirectPath', () => {
  it.each([
    ['/', '/'],
    ['/tasks', '/tasks'],
    ['/work-logs/0190f3a2?tab=photos', '/work-logs/0190f3a2?tab=photos'],
    ['/tasks?status=todo&sort=dueAt%3Aasc#top', '/tasks?status=todo&sort=dueAt%3Aasc#top'],
    ['/search?q=https://example.com', '/search?q=https://example.com'],
  ])('keeps the same-origin path %j', (value, expected) => {
    expect(sanitizeRedirectPath(value)).toBe(expected);
  });

  it.each([
    ['another site', 'https://evil.example/'],
    ['another site without a scheme', '//evil.example/path'],
    ['three slashes', '///evil.example'],
    ['a backslash after the slash', '/\\evil.example'],
    ['a backslash later on', '/tasks\\..\\x'],
    ['a tab that browsers strip', '/\t/evil.example'],
    ['a newline that browsers strip', '/\n/evil.example'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['a relative path without a slash', 'tasks'],
    ['a scheme-relative trick with a user part', '/@evil.example//'],
    ['an empty string', ''],
    ['nothing', null],
    ['undefined', undefined],
  ])('falls back to / for %s', (_name, value) => {
    const result = sanitizeRedirectPath(value);
    // Whatever comes back must resolve to this origin.
    expect(new URL(result, 'https://app.example').origin).toBe('https://app.example');
    if (value !== '/@evil.example//') {
      expect(result).toBe('/');
    }
  });

  it('keeps a path that only looks like a host because of an @', () => {
    expect(sanitizeRedirectPath('/@evil.example//')).toBe('/@evil.example//');
  });

  it('falls back to / for a value that is too long', () => {
    expect(sanitizeRedirectPath(`/${'a'.repeat(3000)}`)).toBe('/');
  });

  it.each(['/login', '/login/', '/activate', '/login?next=/tasks', '/tasks/../login'])(
    'does not send the user back to a sign-in page (%s)',
    (value) => {
      expect(sanitizeRedirectPath(value)).toBe('/');
    },
  );
});

describe('loginPathFor', () => {
  it('is plain /login from the home page', () => {
    expect(loginPathFor('/')).toBe('/login');
  });

  it('remembers the path and its query, encoded', () => {
    expect(loginPathFor('/tasks?status=todo&page=2')).toBe(
      '/login?next=%2Ftasks%3Fstatus%3Dtodo%26page%3D2',
    );
  });

  it('round-trips through the query string', () => {
    const url = new URL(loginPathFor('/tasks?status=todo&page=2'), 'https://app.example');
    expect(sanitizeRedirectPath(url.searchParams.get('next'))).toBe('/tasks?status=todo&page=2');
  });
});

describe('isPublicPath', () => {
  it('knows the two public pages, with or without a trailing slash', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/activate/')).toBe(true);
  });

  it('treats everything else as protected, including look-alikes', () => {
    for (const path of ['/', '/tasks', '/login/extra', '/loginx', '/activate/x', '']) {
      expect(isPublicPath(path)).toBe(false);
    }
  });
});

describe('guardView', () => {
  it('shows a protected page only to a signed-in user', () => {
    expect(guardView('signedIn', '/')).toBe('content');
    expect(guardView('loading', '/')).toBe('loading');
    expect(guardView('signedOut', '/')).toBe('loading');
    expect(guardView('signedOut', '/tasks')).toBe('loading');
  });

  it('shows the sign-in form only once nobody is known to be signed in', () => {
    expect(guardView('signedOut', '/login')).toBe('content');
    expect(guardView('loading', '/login')).toBe('loading');
    expect(guardView('signedIn', '/login')).toBe('loading');
  });

  it('always shows the activation form', () => {
    for (const status of ['loading', 'signedOut', 'signedIn'] as const) {
      expect(guardView(status, '/activate')).toBe('content');
    }
  });
});

describe('guardRedirect', () => {
  it('sends a signed-out user on a protected route to sign-in, remembering the route', () => {
    expect(guardRedirect('signedOut', '/', '')).toBe('/login');
    expect(guardRedirect('signedOut', '/tasks', '?status=todo')).toBe(
      '/login?next=%2Ftasks%3Fstatus%3Dtodo',
    );
  });

  it('sends a signed-in user on /login to where they were going', () => {
    expect(guardRedirect('signedIn', '/login', '')).toBe('/');
    expect(guardRedirect('signedIn', '/login', '?next=%2Ftasks%3Fstatus%3Dtodo')).toBe(
      '/tasks?status=todo',
    );
  });

  it('never sends a signed-in user to another site', () => {
    expect(guardRedirect('signedIn', '/login', '?next=https%3A%2F%2Fevil.example')).toBe('/');
    expect(guardRedirect('signedIn', '/login', '?next=%2F%2Fevil.example')).toBe('/');
  });

  it('leaves everyone else where they are', () => {
    expect(guardRedirect('loading', '/', '')).toBeNull();
    expect(guardRedirect('loading', '/login', '')).toBeNull();
    expect(guardRedirect('signedOut', '/login', '')).toBeNull();
    expect(guardRedirect('signedOut', '/activate', '?code=x')).toBeNull();
    expect(guardRedirect('signedIn', '/activate', '')).toBeNull();
    expect(guardRedirect('signedIn', '/tasks', '')).toBeNull();
  });
});
