import { describe, expect, it } from 'vitest';
import { healthResponseSchema } from './health.js';

describe('healthResponseSchema', () => {
  it('accepts a healthy response', () => {
    const result = healthResponseSchema.safeParse({
      status: 'ok',
      database: 'up',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status', () => {
    const result = healthResponseSchema.safeParse({
      status: 'maybe',
      database: 'up',
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
