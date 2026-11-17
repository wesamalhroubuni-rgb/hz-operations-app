import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadBrand() {
  vi.resetModules();
  return (await import('./brand')).brand;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('brand', () => {
  it('takes the client name from NEXT_PUBLIC_BRAND_NAME', async () => {
    vi.stubEnv('NEXT_PUBLIC_BRAND_NAME', '  Acme  ');

    const brand = await loadBrand();

    expect(brand.name).toBe('Acme');
    expect(brand.logo.alt).toBe('Acme logo');
  });

  it.each([undefined, '', '   '])('falls back to a neutral name when it is %j', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_BRAND_NAME', value);

    const brand = await loadBrand();

    expect(brand.name).toBe('Operations');
  });

  it('names only the client: no builder credit in the published app', async () => {
    vi.stubEnv('NEXT_PUBLIC_BRAND_NAME', 'Acme');

    const brand = await loadBrand();

    expect(JSON.stringify(brand)).not.toMatch(/kaneri|powered by/i);
  });
});
