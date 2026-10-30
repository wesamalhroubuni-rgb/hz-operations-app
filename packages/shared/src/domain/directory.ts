import { z } from 'zod';
import type { ApiResult, ApiTransport } from '../api-client/client.js';
import { idSchema } from '../common/primitives.js';
import { roleSchema } from './enums.js';

// GET /directory [directory.read] (Phase 6, ADR-0009): the names behind the ids. Lists hold ids
// (`authorId`, `siteId`, `assigneeIds`, ...); the dashboard turns them into names, and fills its
// filter pickers, from this one cached call instead of one request per row.
//
// Everything is filtered by the caller's visibility, exactly like GET /users, /sites, /teams and
// /log-types: an id the caller cannot see is simply absent (the client shows "Unknown"). Users
// carry only the `basic` profile (name and roles), never contact details. Archived records are
// included and flagged, so old logs still show names.

/** Most entries per kind; beyond it `truncated` is true and the client falls back to search. */
export const DIRECTORY_MAX_ITEMS = 5000;

export const directoryUserSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  roles: z.array(roleSchema),
  archived: z.boolean(),
});

export const directoryPlaceSchema = z.object({
  id: idSchema,
  name: z.string(),
  parentId: idSchema.nullable(),
  archived: z.boolean(),
});

export const directoryLogTypeSchema = z.object({
  id: idSchema,
  key: z.string(),
  name: z.string(),
  version: z.number().int().min(1),
  archived: z.boolean(),
});

export const directorySchema = z.object({
  users: z.array(directoryUserSchema),
  sites: z.array(directoryPlaceSchema),
  teams: z.array(directoryPlaceSchema),
  logTypes: z.array(directoryLogTypeSchema),
  /** True when one of the lists hit `DIRECTORY_MAX_ITEMS`. */
  truncated: z.boolean(),
});
export type Directory = z.infer<typeof directorySchema>;
export type DirectoryUser = z.infer<typeof directoryUserSchema>;
export type DirectoryPlace = z.infer<typeof directoryPlaceSchema>;
export type DirectoryLogType = z.infer<typeof directoryLogTypeSchema>;

export function directoryEndpoints(transport: ApiTransport) {
  return {
    get(): Promise<ApiResult<Directory>> {
      return transport.request({ path: '/directory', schema: directorySchema });
    },
  };
}
