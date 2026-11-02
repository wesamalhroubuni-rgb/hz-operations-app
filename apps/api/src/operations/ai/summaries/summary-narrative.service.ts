import { Inject, Injectable, Logger } from '@nestjs/common';
import { localeOf, type Locale, type SummaryNarrativeSource } from '@ops/shared';
import {
  AI_RUNNER,
  PROMPT_LOADER,
  untrustedDataBlock,
  type AiRunner,
  type PromptLoader,
} from '../../../platform/ai';
import {
  allowedNumbers,
  buildNarrativeFacts,
  checkNarrative,
  NARRATIVE_MAX_CHARACTERS,
  substitutePeople,
} from './summary-facts';
import { templateNarrative } from './summary-messages';
import type { RecipientSummaryData } from './summary-stats.service';

export const SUMMARY_PROMPT = { id: 'daily-summary-narrative', version: 1 } as const;

/** Room for the narrative and the model's thinking, which cannot be switched off (ADR-0010). */
const MAX_OUTPUT_TOKENS = 2000;

const LANGUAGE_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Turkish',
  ar: 'Arabic',
};

/** Code-chosen instruction placed before the facts block. */
const INSTRUCTION =
  'Write the narrative of the daily summary from these facts. Use only numbers that appear in ' +
  'the facts, and refer to people only by their references (P1, P2, ...).';

export interface WrittenNarrative {
  narrative: string;
  source: SummaryNarrativeSource;
  /** The AiTrace rows of the call(s); empty when no call was made. */
  traceIds: string[];
}

/**
 * Writes a summary's narrative (Phase 7, ADR-0011 section 3): the model gets only the facts
 * computed in code (people as `P1`...), its text must pass the number and reference check
 * (`checkNarrative`, through the runner's `validate`: one retry, then invalid), names are put in
 * after the check, and anything short of a valid answer (AI off, over its limit, refusing,
 * failing, invalid twice) gives the deterministic template instead.
 */
@Injectable()
export class SummaryNarrativeService {
  private readonly logger = new Logger('SummaryNarrative');

  constructor(
    @Inject(AI_RUNNER) private readonly runner: AiRunner,
    @Inject(PROMPT_LOADER) private readonly prompts: PromptLoader,
  ) {}

  async write(
    organizationId: string,
    recipientId: string,
    data: RecipientSummaryData,
    locale: string,
  ): Promise<WrittenNarrative> {
    const language = localeOf(locale);
    const { facts, people } = buildNarrativeFacts(data);
    const allowed = allowedNumbers(facts);
    const prompt = this.prompts.load(SUMMARY_PROMPT.id, SUMMARY_PROMPT.version);
    const outcome = await this.runner.generateText(
      {
        organizationId,
        feature: 'summary_narrative',
        requestedById: null,
        rateLimitKey: null,
        prompt: { id: prompt.id, version: prompt.version },
        inputRefs: {
          subjectType: 'daily_summary',
          recipientId,
          day: data.stats.day,
          people: people.size,
          sites: data.stats.bySite.length,
          teams: data.stats.byTeam.length,
          anomalies: data.anomalies.length,
        },
      },
      {
        system: prompt.render({
          language: LANGUAGE_NAMES[language],
          max_characters: String(NARRATIVE_MAX_CHARACTERS),
        }),
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `${INSTRUCTION}\n\n${untrustedDataBlock('facts', JSON.stringify(facts, null, 1))}`,
              },
            ],
          },
        ],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        validate: (text) => checkNarrative(text, allowed, people),
      },
    );
    if (outcome.ok) {
      return {
        narrative: substitutePeople(outcome.value, people),
        source: 'ai',
        traceIds: outcome.traceIds,
      };
    }
    this.logger.log(
      `Template narrative for recipient ${recipientId} on ${data.stats.day}: ${outcome.failure}` +
        (outcome.errorCode ? ` (${outcome.errorCode})` : ''),
    );
    return {
      narrative: templateNarrative(data.stats, language),
      source: 'template',
      traceIds: outcome.traceIds,
    };
  }
}
