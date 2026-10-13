import type * as EnvModule from './env';

const ORIGINAL_ENV = { ...process.env };

function loadEnv(overrides: Record<string, string | undefined>) {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV, ...overrides };
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- re-evaluate the module per case
  return (require('./env') as typeof EnvModule).env;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('env', () => {
  it('takes the client name from EXPO_PUBLIC_BRAND_NAME', () => {
    expect(loadEnv({ EXPO_PUBLIC_BRAND_NAME: '  Acme  ' }).brandName).toBe('Acme');
  });

  it.each([undefined, '', '   '])('falls back to a neutral name when it is %p', (value) => {
    expect(loadEnv({ EXPO_PUBLIC_BRAND_NAME: value }).brandName).toBe('Operations');
  });

  it('removes trailing slashes from the API URL', () => {
    expect(loadEnv({ EXPO_PUBLIC_API_URL: 'http://api.test:3001//' }).apiUrl).toBe(
      'http://api.test:3001',
    );
  });

  it.each([undefined, '', '  '])('reports no API URL when it is %p', (value) => {
    expect(loadEnv({ EXPO_PUBLIC_API_URL: value }).apiUrl).toBeNull();
  });
});
