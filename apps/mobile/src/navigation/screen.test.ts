import { screenFor } from './screen';

describe('screenFor', () => {
  it('shows the loading screen while the stored session is checked, whatever was chosen', () => {
    expect(screenFor('loading', 'login')).toBe('loading');
    expect(screenFor('loading', 'activate')).toBe('loading');
  });

  it('shows the home screen only to a signed-in user', () => {
    expect(screenFor('signedIn', 'login')).toBe('home');
    expect(screenFor('signedIn', 'activate')).toBe('home');
    expect(screenFor('signedOut', 'login')).not.toBe('home');
    expect(screenFor('signedOut', 'activate')).not.toBe('home');
  });

  it('lets a signed-out user choose between signing in and activating', () => {
    expect(screenFor('signedOut', 'login')).toBe('login');
    expect(screenFor('signedOut', 'activate')).toBe('activate');
  });
});
