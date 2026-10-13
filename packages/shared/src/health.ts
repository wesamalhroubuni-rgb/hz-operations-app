import { z } from 'zod';

/** Response body of the API's GET /health endpoint. */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'error']),
  database: z.enum(['up', 'down']),
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
