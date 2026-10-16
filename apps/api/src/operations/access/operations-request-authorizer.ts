import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthorizationRequest, RequestAuthorizer } from '../../platform/authz';
import { ApiException } from '../../platform/http';
import { hasAnyRole, type AccessContext } from './access-context';
import { AccessService } from './access.service';
import { findPolicy, NON_PRODUCTION_POLICIES, type PolicyDefinition } from './policies';

/**
 * The function-level decision, as a pure function: may somebody with this context use a route
 * governed by this policy at all? An unknown policy and a context without a matching role are
 * both refused.
 */
export function mayUsePolicy(
  policy: PolicyDefinition | undefined,
  context: Pick<AccessContext, 'roles'>,
): boolean {
  return policy !== undefined && hasAnyRole(context as AccessContext, policy.roles);
}

/**
 * The host side of the platform's `RequestAuthorizer` seam. The platform's guard authenticates
 * the request, then calls `authorize` with the route's policy name. This answers the
 * function-level question from the registry, and leaves the caller's access context cached for
 * the services, which apply the object-level rules.
 */
@Injectable()
export class OperationsRequestAuthorizer implements RequestAuthorizer {
  private readonly logger = new Logger(OperationsRequestAuthorizer.name);

  constructor(
    private readonly access: AccessService,
    private readonly config: ConfigService,
  ) {}

  async authorize(request: AuthorizationRequest): Promise<void> {
    const policy = findPolicy(request.policy);
    if (!policy) {
      // A route names a policy nobody defined: a programming error, refused rather than guessed.
      this.logger.error(`Route policy "${request.policy}" is not in the policy registry`);
      throw ApiException.forbidden('You are not allowed to do this');
    }
    // Checked before the role, so in production the route looks absent to everybody.
    if (
      (NON_PRODUCTION_POLICIES as readonly string[]).includes(request.policy) &&
      this.isProduction()
    ) {
      throw ApiException.notFound('Route');
    }
    const context = await this.access.context();
    if (!mayUsePolicy(policy, context)) {
      throw ApiException.forbidden('Your role does not allow this');
    }
  }

  /** Anything that is not explicitly development or test is production: the safe reading. */
  private isProduction(): boolean {
    const nodeEnv: unknown = this.config.get('NODE_ENV');
    return nodeEnv !== 'development' && nodeEnv !== 'test';
  }
}
