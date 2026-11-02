import {
  AI_CAPTURE_MAX_LOG_TYPES,
  AI_CAPTURE_MAX_SITES,
  AI_CAPTURE_MAX_TASKS,
  buildCaptureOutputSchema,
  type CaptureModelOutput,
  type CaptureRefs,
  type CustomFieldDefinition,
  type SmartCaptureInputKind,
} from '@ops/shared';
import type { ZodType } from 'zod';
import { untrustedDataBlock, type LlmContentPart, type LlmMessage } from '../../../platform/ai';

// What the model is offered for one capture (ADR-0010 sections 3 to 5), built by pure functions
// so the rules are unit-tested: the worker's log types (key, name, field definitions), their
// open tasks as `T1`..., their visible sites as `S1`..., the context they had open. Database
// ids never reach the model: references are mapped back by `interpretCaptureOutput`. Every text
// read from the database or written by the worker goes into an untrusted data block.

export interface OfferedLogType {
  id: string;
  key: string;
  name: string;
  description: string | null;
  fields: CustomFieldDefinition[];
}

export interface OfferedTask {
  id: string;
  title: string;
}

export interface OfferedSite {
  id: string;
  name: string;
}

/** The context ids that survived the visibility re-check (null = none or dropped). */
export interface CheckedContext {
  taskId: string | null;
  siteId: string | null;
  logTypeId: string | null;
}

export interface CaptureOffer {
  refs: CaptureRefs;
  schema: ZodType<CaptureModelOutput>;
  /** The data blocks describing what may be chosen, in message order. */
  blocks: string[];
}

/**
 * Orders candidates: the preferred ids first (in the given order), then the rest as given, and
 * keeps at most `max`. Duplicates are kept once.
 */
export function prioritise<Item extends { id: string }>(
  items: readonly Item[],
  preferredIds: readonly (string | null | undefined)[],
  max: number,
): Item[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const result: Item[] = [];
  const seen = new Set<string>();
  const add = (item: Item | undefined) => {
    if (item && !seen.has(item.id) && result.length < max) {
      seen.add(item.id);
      result.push(item);
    }
  };
  for (const id of preferredIds) {
    if (id) add(byId.get(id));
  }
  for (const item of items) add(item);
  return result;
}

/** One line per item, `T1: title`; line breaks inside a title become spaces. */
function referenceLines(prefix: string, labels: readonly string[]): string {
  return labels
    .map((label, index) => `${prefix}${index + 1}: ${label.replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/**
 * The offer of one capture. Caps the lists at the contract's limits (`AI_CAPTURE_MAX_*`), maps
 * tasks and sites to references, and builds the output schema from the offered log types.
 */
export function buildCaptureOffer(input: {
  logTypes: readonly OfferedLogType[];
  tasks: readonly OfferedTask[];
  sites: readonly OfferedSite[];
  context: CheckedContext;
}): CaptureOffer {
  const logTypes = input.logTypes.slice(0, AI_CAPTURE_MAX_LOG_TYPES);
  const tasks = input.tasks.slice(0, AI_CAPTURE_MAX_TASKS);
  const sites = input.sites.slice(0, AI_CAPTURE_MAX_SITES);
  const taskRefs = tasks.map((_task, index) => `T${index + 1}`);
  const siteRefs = sites.map((_site, index) => `S${index + 1}`);
  const refs: CaptureRefs = {
    logTypes: logTypes.map((logType) => ({
      id: logType.id,
      key: logType.key,
      fields: logType.fields,
    })),
    tasks: new Map(tasks.map((task, index) => [taskRefs[index]!, task.id])),
    sites: new Map(sites.map((site, index) => [siteRefs[index]!, site.id])),
  };
  const schema = buildCaptureOutputSchema({
    logTypes: refs.logTypes,
    taskRefs,
    siteRefs,
  });

  const catalogue = logTypes.map((logType) => ({
    key: logType.key,
    name: logType.name,
    ...(logType.description ? { description: logType.description } : {}),
    fields: logType.fields.map((field) => ({
      key: field.key,
      label: field.label,
      type: field.type,
      ...(field.options ? { options: field.options } : {}),
      ...(field.helpText ? { help: field.helpText } : {}),
    })),
  }));
  const open: string[] = [];
  const taskIndex = tasks.findIndex((task) => task.id === input.context.taskId);
  if (taskIndex >= 0) open.push(`task: T${taskIndex + 1}`);
  const siteIndex = sites.findIndex((site) => site.id === input.context.siteId);
  if (siteIndex >= 0) open.push(`site: S${siteIndex + 1}`);
  const openLogType = logTypes.find((logType) => logType.id === input.context.logTypeId);
  if (openLogType) open.push(`log type: ${openLogType.key}`);

  const blocks = [
    untrustedDataBlock('log_types', JSON.stringify(catalogue)),
    untrustedDataBlock(
      'tasks',
      referenceLines(
        'T',
        tasks.map((task) => task.title),
      ) || '(none)',
    ),
    untrustedDataBlock(
      'sites',
      referenceLines(
        'S',
        sites.map((site) => site.name),
      ) || '(none)',
    ),
    untrustedDataBlock('open_context', open.join('\n') || '(none)'),
  ];
  return { refs, schema, blocks };
}

/** The worker's input, as it goes to the model. */
export type CaptureModelInput =
  | { kind: 'voice'; transcript: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'photo';
      note: string | null;
      image: { mediaType: 'image/jpeg' | 'image/png'; data: Uint8Array };
    };

/** The one user message of the extraction: instructions from code, data blocks, the input. */
export function captureMessages(offer: CaptureOffer, input: CaptureModelInput): LlmMessage[] {
  const parts: LlmContentPart[] = [];
  let inputBlock: string;
  switch (input.kind) {
    case 'voice':
      inputBlock = untrustedDataBlock('transcript', input.transcript);
      break;
    case 'text':
      inputBlock = untrustedDataBlock('worker_text', input.text);
      break;
    case 'photo':
      parts.push({ type: 'image', mediaType: input.image.mediaType, data: input.image.data });
      inputBlock = untrustedDataBlock('photo_note', input.note ?? '(none)');
      break;
  }
  const kindLine: Record<SmartCaptureInputKind, string> = {
    voice: 'The worker recorded a voice note; its transcript is below.',
    text: 'The worker typed the note below.',
    photo: 'The worker took the photo above and may have added a note.',
  };
  parts.push({
    type: 'text',
    text: [
      'What may be chosen:',
      ...offer.blocks,
      kindLine[input.kind],
      inputBlock,
      'Propose the work log as the required JSON object.',
    ].join('\n\n'),
  });
  return [{ role: 'user', content: parts }];
}
