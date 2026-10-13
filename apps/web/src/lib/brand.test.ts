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

  it('credits the builder only in the powered-by line', async () => {
    vi.stubEnv('NEXT_PUBLIC_BRAND_NAME', 'Acme');

    const brand = await loadBrand();

    expect(brand.poweredBy).toBe('Powered by Kaneri.ai');
    expect(JSON.stringify({ ...brand, poweredBy: '' })).not.toMatch(/kaneri/i);
  });
});
