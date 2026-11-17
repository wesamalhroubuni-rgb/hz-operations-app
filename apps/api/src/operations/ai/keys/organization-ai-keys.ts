import { Injectable } from '@nestjs/common';
import { aiSettingsOf } from '@ops/shared';
import { PrismaService } from '../../../prisma/prisma.service';
import type { AiOrganizationKeys, AiOrganizationKeysResolver } from '../../../platform/ai';
import { AiKeyVault } from './ai-key-vault';

/**
 * The organization's own AI configuration (ADR-0012), bound to the platform's
 * `AI_ORGANIZATION_KEYS`: its stored provider keys (decrypted for each AI call) and its chosen
 * models (`settings.ai.llmModel` / `sttModel`). An unreadable key (no or another
 * `AI_KEYS_ENCRYPTION_SECRET`) counts as none; an archived organization uses nothing of its own.
 */
@Injectable()
export class OrganizationAiKeys implements AiOrganizationKeysResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: AiKeyVault,
  ) {}

  async keysFor(organizationId: string): Promise<AiOrganizationKeys> {
    const organization = await this.prisma.organization.findFirst({
      where: { id: organizationId, archivedAt: null },
      select: {
        settings: true,
        aiProviderKeys: this.vault.available ? true : false,
      },
    });
    const settings = aiSettingsOf(organization?.settings);
    const keys: AiOrganizationKeys = {
      anthropicApiKey: null,
      openAiApiKey: null,
      llmModel: settings.llmModel,
      speechToTextModel: settings.sttModel,
    };
    for (const row of organization?.aiProviderKeys ?? []) {
      const apiKey = this.vault.open(organizationId, row.provider, row);
      if (row.provider === 'anthropic') keys.anthropicApiKey = apiKey;
      if (row.provider === 'openai') keys.openAiApiKey = apiKey;
    }
    return keys;
  }
}
