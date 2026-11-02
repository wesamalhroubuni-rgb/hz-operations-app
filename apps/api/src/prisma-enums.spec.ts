import {
  AI_DECISIONS,
  AI_TRACE_STATUSES,
  ANOMALY_KINDS,
  ANOMALY_SEVERITIES,
  ATTACHMENT_STATUSES,
  PUSH_PLATFORMS,
  ROLES,
  SMART_CAPTURE_INPUT_KINDS,
  SMART_CAPTURE_STATUSES,
  SUMMARY_NARRATIVE_SOURCES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  WORK_LOG_SOURCES,
  WORK_LOG_STATUSES,
} from '@ops/shared';
import * as prismaEnums from './generated/prisma/enums';

// The enum arrays of @ops/shared must equal the Prisma enums, values and order (AGENTS.md):
// the database sorts enum columns in declaration order, and the wire schemas validate with them.
describe('shared enum arrays equal the Prisma enums', () => {
  it.each([
    ['Role', ROLES],
    ['TaskStatus', TASK_STATUSES],
    ['TaskPriority', TASK_PRIORITIES],
    ['WorkLogStatus', WORK_LOG_STATUSES],
    ['WorkLogSource', WORK_LOG_SOURCES],
    ['AttachmentStatus', ATTACHMENT_STATUSES],
    ['PushPlatform', PUSH_PLATFORMS],
    ['SmartCaptureInputKind', SMART_CAPTURE_INPUT_KINDS],
    ['SmartCaptureStatus', SMART_CAPTURE_STATUSES],
    ['AnomalyKind', ANOMALY_KINDS],
    ['AnomalySeverity', ANOMALY_SEVERITIES],
    ['SummaryNarrativeSource', SUMMARY_NARRATIVE_SOURCES],
    ['AiTraceStatus', AI_TRACE_STATUSES],
    ['AiDecision', AI_DECISIONS],
  ] as const)('%s', (name, values) => {
    const prismaEnum = (prismaEnums as unknown as Record<string, Record<string, string>>)[name];
    expect(Object.values(prismaEnum ?? {})).toEqual([...values]);
  });
});
