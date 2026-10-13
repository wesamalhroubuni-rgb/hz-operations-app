import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiException } from './api-exception';

/**
 * Validates a request part against a Zod schema from @ops/shared and returns the parsed value.
 *
 * @example
 *   create(@Body(new ZodPipe(createSiteSchema)) body: CreateSite) {}
 *   list(@Query(new ZodPipe(listSitesQuerySchema)) query: ListSitesQuery) {}
 *   get(@Param('id', new ZodPipe(idSchema)) id: string) {}
 */
export class ZodPipe<Schema extends z.ZodType> implements PipeTransform<unknown, z.infer<Schema>> {
  constructor(private readonly schema: Schema) {}

  transform(value: unknown): z.infer<Schema> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    throw ApiException.validation(
      result.error.issues.flatMap((issue) => {
        const path = issue.path.join('.');
        // One detail per unknown key, with the key in `path`, so a client can point at the field.
        if (issue.code === 'unrecognized_keys') {
          return issue.keys.map((key) => ({
            path: path ? `${path}.${key}` : key,
            message: 'is not a recognised field',
          }));
        }
        return [{ path, message: issue.message }];
      }),
    );
  }
}
