import { Inject, Injectable } from '@nestjs/common';
import { AI_KEY_PROVIDERS, aiKeyHint, type AiKeyProvider, type AiProviderKeys } from '@ops/shared';
import { Prisma } from '../../../generated/prisma/client';
import { AiKeyChecker, AiProviderSelector, type AiKeyKind } from '../../../platform/ai';
import { RATE_LIMITER, type RateLimiter } from '../../../platform/auth';
import { ApiException } from '../../../platform/http';
import { PrismaService } from '../../../prisma/prisma.service';
import { AccessService } from '../../access';
import { ChangeRecorder } from '../../common/change-recorder';
import { AiKeyVault } from './ai-key-vault';

const KIND: Record<AiKeyProvider, AiKeyKind> = { anthropic: 'llm', openai: 'speechToText' };

/**
 * Key checks one admin may start: each one is a request to the provider, so the route cannot be
 * used to test many keys quickly (ADR-0012).
 */
export const AI_KEY_CHECK_RATE_LIMIT = { limit: 5, windowSeconds: 60 };

/**
 * An organization's own AI provider keys (ADR-0012), managed by its admins: where each key in
 * force comes from, save (after checking it with the provider for the organization's model), and
 * remove. The key itself never leaves this service: answers carry the source and a four-character
 * hint; the audit and outbox payloads carry the provider only.
 */
@Injectable()
export class AiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly changes: ChangeRecorder,
    private readonly vault: AiKeyVault,
    private readonly checker: AiKeyChecker,
    private readonly selector: AiProviderSelector,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  async status(): Promise<AiProviderKeys> {
    const { organizationId } = await this.access.context();
    return this.statusOf(organizationId);
  }

  async set(provider: AiKeyProvider, apiKey: string): Promise<AiProviderKeys> {
    const { organizationId, userId } = await this.access.context();
    if (!this.vault.available) {
      throw ApiException.of(
        'ai_key_storage_unavailable',
        'This server cannot store AI keys: AI_KEYS_ENCRYPTION_SECRET is not set.',
      );
    }
    const decision = await this.limiter.hit(`ai_key_check:${userId}`, AI_KEY_CHECK_RATE_LIMIT);
    if (!decision.allowed) {
      throw ApiException.rateLimited(
        'Too many key checks. Try again in a minute.',
        decision.retryAfterSeconds,
      );
    }
    const { models } = await this.selector.forOrganization(organizationId);
    const model = provider === 'anthropic' ? models.llm : models.speechToText;
    const checked = await this.checker.check(organizationId, KIND[provider], apiKey, model);
    if (!checked.ok) {
      if (checked.failure === 'unavailable') {
        throw ApiException.of(
          'ai_unavailable',
          `The ${provider} service could not be reached to check the key; try again later.`,
        );
      }
      // 404: the key may be fine, but it has no access to the chosen model.
      const detail =
        checked.errorCode === 'http_404'
          ? { path: 'model', message: `no access to the model ${model}` }
          : { path: 'apiKey', message: `refused by the provider (${checked.errorCode})` };
      throw ApiException.of('ai_key_invalid', `The ${provider} service refused this key.`, [
        detail,
      ]);
    }
    const sealed = this.vault.seal(organizationId, provider, apiKey);
    const hint = aiKeyHint(apiKey);
    try {
      await this.save(organizationId, userId, provider, { ...sealed, hint });
    } catch (error) {
      // Two admins saving the first key at once: the second one updates the row instead.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        await this.save(organizationId, userId, provider, { ...sealed, hint });
      } else {
        throw error;
      }
    }
    return this.statusOf(organizationId);
  }

  async remove(provider: AiKeyProvider): Promise<AiProviderKeys> {
    const { organizationId } = await this.access.context();
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.aiProviderKey.findUnique({
        where: { organizationId_provider: { organizationId, provider } },
        select: { id: true },
      });
      if (!existing) {
        return; // Removing a key that is not there is a no-op (200 with the status).
      }
      await tx.aiProviderKey.delete({ where: { id: existing.id } });
      await this.changes.record(tx, {
        organizationId,
        entityType: 'ai_provider_key',
        verb: 'deleted',
        entityId: existing.id,
        before: { provider, stored: true },
        after: { provider, stored: false },
      });
    });
    return this.statusOf(organizationId);
  }

  private save(
    organizationId: string,
    userId: string,
    provider: AiKeyProvider,
    data: ReturnType<AiKeyVault['seal']> & { hint: string },
  ): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.aiProviderKey.findUnique({
        where: { organizationId_provider: { organizationId, provider } },
        select: { id: true },
      });
      const row = existing
        ? await tx.aiProviderKey.update({
            where: { id: existing.id },
            data: { ...data, updatedById: userId },
            select: { id: true },
          })
        : await tx.aiProviderKey.create({
            data: { organizationId, provider, ...data, updatedById: userId },
            select: { id: true },
          });
      await this.changes.record(tx, {
        organizationId,
        entityType: 'ai_provider_key',
        verb: existing ? 'updated' : 'created',
        entityId: row.id,
        // The provider only: never the key, its hint or its ciphertext.
        ...(existing ? { before: { provider, stored: true } } : {}),
        after: { provider, stored: true },
      });
    });
  }

  private async statusOf(organizationId: string): Promise<AiProviderKeys> {
    const [rows, providers] = await Promise.all([
      this.prisma.aiProviderKey.findMany({ where: { organizationId } }),
      this.selector.forOrganization(organizationId),
    ]);
    return {
      storageAvailable: this.vault.available,
      keys: AI_KEY_PROVIDERS.map((provider) => {
        const row = rows.find((candidate) => candidate.provider === provider);
        return {
          provider,
          source: providers.sources[KIND[provider]],
          // A stored key that is not in force (unreadable, or AI_PROVIDER=fake) still shows its hint.
          hint: row?.hint ?? null,
          updatedAt: row ? row.updatedAt.toISOString() : null,
          unreadable: row ? this.vault.open(organizationId, provider, row) === null : false,
          model: provider === 'anthropic' ? providers.models.llm : providers.models.speechToText,
        };
      }),
    };
  }
}
