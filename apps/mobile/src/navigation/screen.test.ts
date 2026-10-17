import { rootViewFor } from './screen';

describe('rootViewFor', () => {
  it('shows only the loading screen while the stored session is checked', () => {
    expect(rootViewFor('loading')).toBe('loading');
  });

  it('shows the signed-in navigator only to a signed-in user', () => {
    expect(rootViewFor('signedIn')).toBe('signedIn');
    expect(rootViewFor('signedOut')).toBe('signedOut');
  });
});
