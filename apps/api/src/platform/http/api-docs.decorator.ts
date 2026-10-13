import { applyDecorators, HttpStatus } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { apiErrorSchema } from '@ops/shared';
import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

export interface ApiDocsOptions {
  summary: string;
  description?: string;
  /** Extra tags for this route, on top of the controller's `@ApiTags`. */
  tags?: string[];
  /** Schemas of the path parameters, by name: `{ id: idSchema }`. */
  params?: Record<string, z.ZodType>;
  /** Schema of the JSON request body. */
  body?: z.ZodType;
  /** Object schema of the query string; each property becomes one query parameter. */
  query?: z.ZodType;
  /** Schema of the success response body. */
  response?: z.ZodType;
  /** Success status. Defaults to 200. */
  status?: HttpStatus;
  /** Error statuses this route can answer with, beyond 400 and 401 which every route has. */
  errors?: HttpStatus[];
}

function isBooleanSchema(schema: unknown): boolean {
  return typeof schema === 'object' && schema !== null && 'type' in schema
    ? schema.type === 'boolean'
    : false;
}

/**
 * Makes a generated schema readable in the docs without changing what it means:
 * - drops the long validation regex next to a `format` (uuid, date-time), which says the same;
 * - drops integer bounds that are only the limits of a JavaScript number;
 * - shows a query-string boolean ("true"/"false" or a real boolean) as a plain boolean.
 */
export function tidyOpenApiSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(tidyOpenApiSchema);
  }
  if (typeof node !== 'object' || node === null) {
    return node;
  }

  const source = node as JsonSchema;
  if (Array.isArray(source.anyOf) && source.anyOf.some(isBooleanSchema)) {
    const { anyOf: _anyOf, ...rest } = source;
    return { ...rest, type: 'boolean' };
  }

  const tidy: JsonSchema = {};
  for (const [key, value] of Object.entries(source)) {
    const redundantPattern = key === 'pattern' && typeof source.format === 'string';
    const numberLimit =
      (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) ||
      (key === 'minimum' && value === Number.MIN_SAFE_INTEGER);
    if (!redundantPattern && !numberLimit) {
      tidy[key] = tidyOpenApiSchema(value);
    }
  }
  return tidy;
}

/** Converts a Zod schema to an OpenAPI schema object; never throws. */
export function toOpenApiSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  try {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
      target: 'openapi-3.0',
      io,
      unrepresentable: 'any',
    }) as JsonSchema;
    return tidyOpenApiSchema(rest) as JsonSchema;
  } catch {
    return {};
  }
}

/**
 * Documents a route in the OpenAPI spec from the same Zod schemas that validate it, so the docs
 * cannot drift from the validation.
 *
 * @example
 *   @Post()
 *   @ApiDocs({ summary: 'Create a site', body: createSiteSchema, response: siteSchema, status: 201 })
 */
export function ApiDocs(options: ApiDocsOptions): MethodDecorator {
  const decorators: MethodDecorator[] = [
    ApiOperation({ summary: options.summary, description: options.description }),
  ];

  if (options.tags && options.tags.length > 0) {
    decorators.push(ApiTags(...options.tags));
  }

  for (const [name, schema] of Object.entries(options.params ?? {})) {
    decorators.push(ApiParam({ name, required: true, schema: toOpenApiSchema(schema, 'input') }));
  }

  if (options.body) {
    decorators.push(ApiBody({ schema: toOpenApiSchema(options.body, 'input') }));
  }

  if (options.query) {
    const querySchema = toOpenApiSchema(options.query, 'input');
    const properties = (querySchema.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((querySchema.required ?? []) as string[]);
    for (const [name, schema] of Object.entries(properties)) {
      decorators.push(ApiQuery({ name, required: required.has(name), schema }));
    }
  }

  decorators.push(
    ApiResponse({
      status: options.status ?? HttpStatus.OK,
      ...(options.response ? { schema: toOpenApiSchema(options.response, 'output') } : {}),
    }),
  );

  const errorSchema = toOpenApiSchema(apiErrorSchema, 'output');
  const errorStatuses = new Set([
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    ...(options.errors ?? []),
  ]);
  for (const status of errorStatuses) {
    decorators.push(ApiResponse({ status, schema: errorSchema }));
  }

  return applyDecorators(...decorators);
}
