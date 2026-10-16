import { z } from 'zod';

// These arrays must match the Prisma enums in apps/api/prisma/schema.prisma exactly (same
// values, same order: the database sorts enum columns in declaration order).

export const ROLES = ['worker', 'supervisor', 'manager', 'admin'] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * Rank of a role: `worker` 0 < `supervisor` 1 < `manager` 2 < `admin` 3. Anything that is not a
 * known role ranks -1, below every role, so a comparison with an unknown value never grants.
 */
export function roleRank(role: string | null | undefined): number {
  return ROLES.indexOf(role as Role);
}

/** The distinct known roles of a list, highest first. */
export function rolesHighestFirst(roles: Iterable<string>): Role[] {
  const held = new Set(roles);
  return ROLES.filter((role) => held.has(role)).reverse();
}

export const TASK_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const WORK_LOG_STATUSES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export const workLogStatusSchema = z.enum(WORK_LOG_STATUSES);
export type WorkLogStatus = z.infer<typeof workLogStatusSchema>;

/** How a work log was captured. Everything is `manual` until the AI phases. */
export const WORK_LOG_SOURCES = ['manual', 'voice', 'photo', 'ai'] as const;
export const workLogSourceSchema = z.enum(WORK_LOG_SOURCES);
export type WorkLogSource = z.infer<typeof workLogSourceSchema>;
