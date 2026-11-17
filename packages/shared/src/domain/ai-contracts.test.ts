import { describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  aiSettingsOf,
  aiFeaturesOf,
  anomalyFlagSchema,
  buildCaptureOutputSchema,
  compareWithProposal,
  createSmartCaptureSchema,
  createWorkLogSchema,
  dailySummarySchema,
  effectiveAiLimit,
  generateDailySummariesSchema,
  interpretCaptureOutput,
  isRetryableApiErrorCode,
  organizationSettingsSchema,
  toStructuredOutputJsonSchema,
  workLogSchema,
  type CaptureModelOutput,
  type CustomFieldDefinition,
} from '../index.js';

const ID = '0192f0c1-7d3a-7cc0-8000-000000000001';
const ID2 = '0192f0c1-7d3a-7cc0-8000-000000000002';
const NOW = '2026-10-30T15:00:00+03:00';

describe('Phase 7 error codes', () => {
  it('gives each AI code its status, and only ai_unavailable is retryable', () => {
    expect(API_ERROR_STATUS.ai_disabled).toBe(403);
    expect(API_ERROR_STATUS.ai_limit_reached).toBe(429);
    expect(API_ERROR_STATUS.ai_unavailable).toBe(503);
    expect(isRetryableApiErrorCode('ai_unavailable')).toBe(true);
    expect(isRetryableApiErrorCode('ai_disabled')).toBe(false);
    expect(isRetryableApiErrorCode('ai_limit_reached')).toBe(false);
  });
});

describe('organization AI settings', () => {
  it('defaults every feature off, 18:00, supervisors and managers, no own limits', () => {
    expect(aiSettingsOf({})).toEqual({
      smartCaptureEnabled: false,
      dailySummaryEnabled: false,
      summaryTime: '18:00',
      summaryRecipientRoles: ['supervisor', 'manager'],
      dailyRequestLimit: null,
      dailyCostLimitUsd: null,
      llmModel: null,
      sttModel: null,
    });
    expect(aiSettingsOf(null)).toEqual(aiSettingsOf({}));
  });

  it('reads a chosen model and ignores one that is not offered (ADR-0012)', () => {
    expect(
      aiSettingsOf({ ai: { llmModel: 'claude-haiku-5-5', sttModel: 'whisper-1' } }),
    ).toMatchObject({ llmModel: 'claude-haiku-5-5', sttModel: 'whisper-1' });
    expect(aiSettingsOf({ ai: { llmModel: 'gpt-5', sttModel: 42 } })).toMatchObject({
      llmModel: null,
      sttModel: null,
    });
  });

  it('reads stored values and ignores unusable ones key by key', () => {
    const settings = {
      ai: {
        smartCaptureEnabled: true,
        dailySummaryEnabled: 'yes',
        summaryTime: '25:00',
        summaryRecipientRoles: ['manager'],
        dailyRequestLimit: 50,
        dailyCostLimitUsd: -1,
      },
    };
    expect(aiSettingsOf(settings)).toMatchObject({
      smartCaptureEnabled: true,
      dailySummaryEnabled: false,
      summaryTime: '18:00',
      summaryRecipientRoles: ['manager'],
      dailyRequestLimit: 50,
      dailyCostLimitUsd: null,
    });
  });

  it('validates the ai block of PATCH /organization strictly', () => {
    const ok = organizationSettingsSchema.safeParse({
      ai: { smartCaptureEnabled: true, summaryTime: '07:30', summaryRecipientRoles: ['admin'] },
    });
    expect(ok.success).toBe(true);
    for (const ai of [
      { summaryTime: '7:30' },
      { summaryRecipientRoles: ['worker'] },
      { summaryRecipientRoles: ['manager', 'manager'] },
      { dailyRequestLimit: 1.5 },
      { unknownSwitch: true },
    ]) {
      expect(organizationSettingsSchema.safeParse({ ai }).success).toBe(false);
    }
  });

  it('never lets an organization limit raise the environment ceiling', () => {
    expect(effectiveAiLimit(200, null)).toBe(200);
    expect(effectiveAiLimit(200, 50)).toBe(50);
    expect(effectiveAiLimit(200, 5000)).toBe(200);
  });

  it('treats a summary without aiFeatures as both off', () => {
    expect(aiFeaturesOf({})).toEqual({ smartCapture: false, dailySummary: false });
    expect(aiFeaturesOf({ aiFeatures: { smartCapture: true, dailySummary: false } })).toEqual({
      smartCapture: true,
      dailySummary: false,
    });
  });
});

describe('POST /ai/capture body', () => {
  const context = { capturedAt: NOW, taskId: ID };

  it('accepts each input kind', () => {
    expect(
      createSmartCaptureSchema.safeParse({ kind: 'text', clientId: ID, context, text: 'Done' })
        .success,
    ).toBe(true);
    expect(
      createSmartCaptureSchema.safeParse({
        kind: 'voice',
        clientId: ID,
        context: { ...context, languageHint: 'tr' },
        mimeType: 'audio/mp4',
        sizeBytes: 1000,
        durationMs: 30_000,
      }).success,
    ).toBe(true);
    expect(
      createSmartCaptureSchema.safeParse({
        kind: 'photo',
        clientId: ID,
        context,
        mimeType: 'image/jpeg',
        sizeBytes: 1000,
      }).success,
    ).toBe(true);
  });

  it('refuses unknown keys, wrong types, too long notes and missing capture time', () => {
    const voice = {
      kind: 'voice',
      clientId: ID,
      context,
      mimeType: 'audio/mp4',
      sizeBytes: 1000,
      durationMs: 1000,
    };
    for (const body of [
      { ...voice, durationMs: 120_001 },
      { ...voice, mimeType: 'video/mp4' },
      { ...voice, storageKey: 'x' },
      { ...voice, context: { taskId: ID } },
      { ...voice, context: { ...context, workerId: ID } },
      { kind: 'text', clientId: ID, context, text: '   ' },
      { kind: 'text', clientId: ID, context, text: 'x'.repeat(4001) },
      { kind: 'video', clientId: ID, context },
    ]) {
      expect(createSmartCaptureSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('POST /work-logs confirming a capture', () => {
  const base = { clientId: ID, occurredAt: NOW };

  it('requires aiProposalId with ai_assisted and refuses it otherwise', () => {
    expect(
      createWorkLogSchema.safeParse({ ...base, source: 'ai_assisted', aiProposalId: ID2 }).success,
    ).toBe(true);
    expect(createWorkLogSchema.safeParse({ ...base, source: 'ai_assisted' }).success).toBe(false);
    expect(createWorkLogSchema.safeParse({ ...base, aiProposalId: ID2 }).success).toBe(false);
    expect(createWorkLogSchema.safeParse({ ...base, source: 'voice' }).success).toBe(false);
    expect(createWorkLogSchema.safeParse({ ...base, aiMetadata: { captureId: ID } }).success).toBe(
      false,
    );
    expect(createWorkLogSchema.parse(base).source).toBe('manual');
  });

  it('types aiMetadata on a work log', () => {
    const metadata = {
      captureId: ID,
      inputKind: 'voice',
      traceIds: [ID2],
      model: 'fake-llm',
      promptId: 'smart-capture-extract',
      promptVersion: 1,
      keptFields: ['text'],
      changedFields: [],
      addedFields: [],
    };
    expect(workLogSchema.shape.aiMetadata.safeParse(metadata).success).toBe(true);
    expect(workLogSchema.shape.aiMetadata.safeParse(null).success).toBe(true);
    expect(workLogSchema.shape.aiMetadata.safeParse({ captureId: 'x' }).success).toBe(false);
  });
});

const inspection: CustomFieldDefinition[] = [
  { key: 'area', label: 'Area', type: 'text', required: true },
  { key: 'count', label: 'Count', type: 'number', required: false },
  { key: 'ok', label: 'Passed', type: 'boolean', required: false },
  { key: 'grade', label: 'Grade', type: 'select', required: false, options: ['A', 'B'] },
  { key: 'due', label: 'Due', type: 'date', required: false },
];

const options = {
  logTypes: [
    { key: 'inspection', fields: inspection },
    { key: 'delivery', fields: [] },
  ],
  taskRefs: ['T1', 'T2'],
  siteRefs: ['S1'],
};

const fullFields = (): CaptureModelOutput['fields'] => [
  { field: 'inspection.area', value: 'Roof', confidence: 'high' },
  { field: 'inspection.count', value: 3, confidence: 'medium' },
  { field: 'inspection.ok', value: true, confidence: 'low' },
  { field: 'inspection.grade', value: 'B', confidence: 'high' },
  { field: 'inspection.due', value: '2026-11-02', confidence: 'low' },
];

function answer(overrides: Partial<CaptureModelOutput> = {}): CaptureModelOutput {
  return {
    logTypeKey: 'inspection',
    logTypeConfidence: 'high',
    fields: fullFields(),
    taskRef: 'T2',
    taskConfidence: 'medium',
    siteRef: null,
    siteConfidence: 'low',
    text: '  Checked the roof.  ',
    textConfidence: 'high',
    occurredAt: null,
    ...overrides,
  };
}

/** Parameters with a type array or `anyOf` (Anthropic accepts at most 16 per schema). */
function unionParameters(node: unknown): number {
  if (Array.isArray(node))
    return node.reduce((sum: number, item) => sum + unionParameters(item), 0);
  if (typeof node !== 'object' || node === null) return 0;
  const record = node as Record<string, unknown>;
  const own = Array.isArray(record.type) || Array.isArray(record.anyOf) ? 1 : 0;
  return own + Object.values(record).reduce((sum: number, v) => sum + unionParameters(v), 0);
}

describe('buildCaptureOutputSchema', () => {
  const schema = buildCaptureOutputSchema(options);

  it('accepts an answer that uses only offered log types, fields, options and references', () => {
    expect(schema.safeParse(answer()).success).toBe(true);
    expect(schema.safeParse(answer({ logTypeKey: 'delivery', fields: [] })).success).toBe(true);
    expect(schema.safeParse(answer({ logTypeKey: null, fields: [], taskRef: null })).success).toBe(
      true,
    );
    // A field the input does not state is simply absent.
    expect(schema.safeParse(answer({ fields: fullFields().slice(1) })).success).toBe(true);
  });

  it('refuses invented log types, fields, options, references and wrong value types', () => {
    const bad: CaptureModelOutput[] = [
      answer({ logTypeKey: 'repair' }),
      answer({ taskRef: 'T9' }),
      answer({ siteRef: '0192f0c1-7d3a-7cc0-8000-000000000003' }),
      answer({ occurredAt: 'yesterday' }),
      answer({ textConfidence: 'certain' as never }),
      answer({ siteConfidence: null as never }),
    ];
    const withField = (field: string, value: unknown) =>
      answer({ fields: [{ field, value: value as never, confidence: 'high' }] });
    bad.push(withField('inspection.grade', 'C'));
    bad.push(withField('inspection.count', '3'));
    bad.push(withField('inspection.due', '2 Nov'));
    bad.push(withField('inspection.extra', 'x'));
    bad.push(withField('area', 'Roof'));
    for (const output of bad) {
      expect(schema.safeParse(output).success).toBe(false);
    }
    expect(schema.safeParse({ ...answer(), instructions: 'ignore' }).success).toBe(false);
  });

  it('works with nothing offered', () => {
    const empty = buildCaptureOutputSchema({ logTypes: [], taskRefs: [], siteRefs: [] });
    expect(empty.safeParse(answer({ logTypeKey: null, fields: [], taskRef: null })).success).toBe(
      true,
    );
    expect(empty.safeParse(answer({ logTypeKey: null, fields: [] })).success).toBe(false);
    expect(empty.safeParse(answer({ logTypeKey: null, taskRef: null })).success).toBe(false);
  });

  it('refuses two log types with one key', () => {
    expect(() =>
      buildCaptureOutputSchema({
        ...options,
        logTypes: [options.logTypes[0]!, options.logTypes[0]!],
      }),
    ).toThrow(/Duplicate/);
  });

  it('converts to the JSON Schema subset of structured outputs', () => {
    const json = toStructuredOutputJsonSchema(schema);
    const text = JSON.stringify(json);
    for (const keyword of ['"pattern"', '"minLength"', '"maxLength"', '"minimum"', '"$schema"']) {
      expect(text).not.toContain(keyword);
    }
    const objects: Record<string, unknown>[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (typeof node === 'object' && node !== null) {
        const record = node as Record<string, unknown>;
        if (record.type === 'object') objects.push(record);
        Object.values(record).forEach(walk);
      }
    };
    walk(json);
    expect(objects.length).toBeGreaterThan(3);
    for (const object of objects) {
      expect(object.additionalProperties).toBe(false);
      const required = (object.required as string[] | undefined) ?? [];
      expect(required.sort()).toEqual(Object.keys(object.properties as object).sort());
    }
    expect(text).toContain('"enum":["A","B"]');
  });

  it('stays within the 16 union-typed parameters structured outputs allow, whatever is offered', () => {
    // Found with the first real call (2026-11-17): the earlier shape had 33 and every capture
    // was refused with HTTP 400.
    const many = {
      logTypes: Array.from({ length: 10 }, (_, type) => ({
        key: `type_${type}`,
        fields: inspection.map((field) => ({ ...field, key: `${field.key}_${type}` })),
      })),
      taskRefs: Array.from({ length: 30 }, (_, index) => `T${index + 1}`),
      siteRefs: Array.from({ length: 30 }, (_, index) => `S${index + 1}`),
    };
    for (const offered of [options, many, { logTypes: [], taskRefs: [], siteRefs: [] }]) {
      const json = toStructuredOutputJsonSchema(buildCaptureOutputSchema(offered));
      expect(unionParameters(json)).toBeLessThanOrEqual(6);
    }
  });
});

describe('interpretCaptureOutput', () => {
  const refs = {
    logTypes: [{ key: 'inspection', id: ID, fields: inspection }],
    tasks: new Map([
      ['T1', '0192f0c1-7d3a-7cc0-8000-0000000000a1'],
      ['T2', '0192f0c1-7d3a-7cc0-8000-0000000000a2'],
    ]),
    sites: new Map([['S1', '0192f0c1-7d3a-7cc0-8000-0000000000b1']]),
  };

  it('maps references back to ids, trims the text and keeps confidence of what was proposed', () => {
    const result = interpretCaptureOutput(answer(), refs, NOW);
    expect(result.proposal).toEqual({
      logTypeId: ID,
      taskId: '0192f0c1-7d3a-7cc0-8000-0000000000a2',
      siteId: null,
      text: 'Checked the roof.',
      customFields: { area: 'Roof', count: 3, ok: true, grade: 'B', due: '2026-11-02' },
      occurredAt: NOW,
    });
    expect(result.confidence).toEqual({
      logType: 'high',
      task: 'medium',
      site: null,
      text: 'high',
      customFields: { area: 'high', count: 'medium', ok: 'low', grade: 'high', due: 'low' },
    });
    expect(result.droppedFields).toEqual([]);
  });

  it('drops a value that breaks its field rule and leaves a required field for the worker', () => {
    const output = answer({
      fields: [{ field: 'inspection.area', value: 'x'.repeat(2001), confidence: 'high' }],
      text: '   ',
      occurredAt: '2026-10-30T09:00:00+03:00',
    });
    const result = interpretCaptureOutput(output, refs, NOW);
    expect(result.proposal.customFields).toEqual({});
    expect(result.proposal.text).toBeNull();
    expect(result.proposal.occurredAt).toBe('2026-10-30T09:00:00+03:00');
    expect(result.droppedFields).toEqual(['customFields.area']);
    expect(result.confidence.text).toBeNull();
  });

  it('ignores fields of another log type and keeps the first entry of a repeated field', () => {
    const result = interpretCaptureOutput(
      answer({
        fields: [
          { field: 'delivery.area', value: 'Dock', confidence: 'high' },
          { field: 'inspection.area', value: 'Roof', confidence: 'medium' },
          { field: 'inspection.area', value: 'Gate', confidence: 'high' },
        ],
      }),
      refs,
      NOW,
    );
    expect(result.proposal.customFields).toEqual({ area: 'Roof' });
    expect(result.confidence.customFields).toEqual({ area: 'medium' });
  });

  it('ignores a log type or reference it does not know', () => {
    const result = interpretCaptureOutput(
      answer({ logTypeKey: 'other', taskRef: 'T7' }),
      refs,
      NOW,
    );
    expect(result.proposal).toMatchObject({ logTypeId: null, taskId: null, customFields: {} });
    expect(result.confidence.logType).toBeNull();
  });
});

describe('compareWithProposal', () => {
  it('lists kept, changed and added fields', () => {
    const proposal = {
      logTypeId: ID,
      taskId: null,
      siteId: ID2,
      text: 'Roof done',
      customFields: { area: 'Roof', count: 3 },
      occurredAt: '2026-10-30T12:00:00Z',
    };
    expect(
      compareWithProposal(proposal, {
        logTypeId: ID,
        taskId: ID2,
        siteId: null,
        text: 'Roof done',
        occurredAt: '2026-10-30T15:00:00+03:00',
        customFields: { area: 'Roof', count: 4, grade: 'A' },
      }),
    ).toEqual({
      keptFields: ['logTypeId', 'text', 'occurredAt', 'customFields.area'],
      changedFields: ['siteId', 'customFields.count'],
      addedFields: ['taskId', 'customFields.grade'],
    });
  });
});

describe('summaries and anomalies', () => {
  const flagBase = {
    id: ID,
    organizationId: ID2,
    day: '2026-10-30',
    severity: 'medium',
    siteId: ID,
    teamId: null,
    userId: null,
    taskId: null,
    workLogId: null,
    logTypeId: null,
    createdAt: NOW,
  };

  it('checks the params of each anomaly kind', () => {
    expect(
      anomalyFlagSchema.safeParse({
        ...flagBase,
        kind: 'no_activity_site',
        params: { lookbackDays: 14, lastLogAt: null, openTasks: 2 },
      }).success,
    ).toBe(true);
    expect(
      anomalyFlagSchema.safeParse({
        ...flagBase,
        kind: 'far_location',
        params: { lookbackDays: 14, lastLogAt: null, openTasks: 2 },
      }).success,
    ).toBe(false);
  });

  it('parses a summary and refuses an unknown key in the generate body', () => {
    const zero = {
      id: null,
      name: null,
      logs: 0,
      tasksOpen: 0,
      tasksOverdue: 0,
      tasksBlocked: 0,
      tasksCompleted: 0,
    };
    const summary = {
      id: ID,
      organizationId: ID2,
      recipientId: ID,
      day: '2026-10-30',
      timeZone: 'Europe/Istanbul',
      scope: { roles: ['supervisor'], orgWide: false, siteIds: [ID], teamIds: [], peopleCount: 4 },
      stats: {
        day: '2026-10-30',
        timeZone: 'Europe/Istanbul',
        dayStart: '2026-10-29T21:00:00Z',
        dayEnd: '2026-10-30T21:00:00Z',
        logs: { total: 3, draft: 0, submitted: 1, approved: 1, rejected: 1, aiAssisted: 1 },
        reviews: { approved: 1, rejected: 1 },
        awaitingApproval: 2,
        tasks: { open: 4, overdue: 1, blocked: 1, completed: 2, created: 1 },
        workers: { active: 3, idle: 1 },
        bySite: [zero],
        byTeam: [],
        anomalies: {
          total: 0,
          byKind: { no_activity_site: 0, slow_task: 0, repeated_rejections: 0, far_location: 0 },
        },
      },
      anomalies: [],
      narrative: 'A quiet day.',
      narrativeSource: 'template',
      locale: 'en',
      createdAt: NOW,
    };
    expect(dailySummarySchema.safeParse(summary).success).toBe(true);
    expect(generateDailySummariesSchema.safeParse({ day: '2026-10-30' }).success).toBe(true);
    expect(generateDailySummariesSchema.safeParse({ force: true }).success).toBe(false);
  });
});
