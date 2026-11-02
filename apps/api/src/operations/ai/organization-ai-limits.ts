import { Injectable } from '@nestjs/common';
import { aiSettingsOf } from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import type { AiOrganizationLimits, AiOrganizationLimitsResolver } from '../../platform/ai';

/**
 * The organization's own AI limits (`settings.ai.dailyRequestLimit` / `dailyCostLimitUsd`,
 * ADR-0010 section 7), bound to the platform's `AI_ORGANIZATION_LIMITS`. A missing or archived
 * organization has no limits of its own (the environment's ceiling applies).
 */
@Injectable()
export class OrganizationAiLimits implements AiOrganizationLimitsResolver {
  constructor(private readonly prisma: PrismaService) {}

  async limitsFor(organizationId: string): Promise<AiOrganizationLimits> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = aiSettingsOf(organization?.settings);
    return {
      dailyRequestLimit: settings.dailyRequestLimit,
      dailyCostLimitUsd: settings.dailyCostLimitUsd,
    };
  }
}
