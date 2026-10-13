/**
 * TEMPORARY development-only authentication. Replaced by real sign-in in Phase 3; delete this
 * folder then and put the real guard in its place.
 *
 * Host requirements: `ConfigService` answering `NODE_ENV` and `DEV_AUTH_ENABLED` (a boolean), a
 * database client with a `user` table holding `id`, `organizationId` and `archivedAt` (injected as
 * `PrismaService`, used only through the `DevActorUserReader` slice), and the `DEV_USER_HEADER`
 * constant from the shared package.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { DEV_USER_HEADER, idSchema } from '@ops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiException } from '../http/api-exception';
import { IS_PUBLIC_KEY } from '../http/public.decorator';
import { RequestContext } from '../request-context/request-context';
import { isDevAuthEnabled } from './dev-auth.policy';

/** The slice of the database client this guard reads through. */
export interface DevActorUserReader {
  user: {
    findUnique(args: {
      where: { id: string };
      select: { id: true; organizationId: true; archivedAt: true };
    }): PromiseLike<{ id: string; organizationId: string; archivedAt: Date | null } | null>;
  };
}

interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Global guard that gives every non-public request an acting user.
 *
 * - `@Public()` routes pass without one.
 * - Dev auth enabled (NODE_ENV is `development` AND DEV_AUTH_ENABLED is true, see
 *   `isDevAuthEnabled`): the `x-dev-user-id` header must name an existing, non-archived user, who
 *   becomes the actor of the request. Anything else is a 401.
 * - Dev auth not enabled: every non-public route is a 401 and the header is never read.
 *
 * The environment validation already refuses to boot with DEV_AUTH_ENABLED outside development;
 * the check here is a second, independent barrier.
 */
@Injectable()
export class DevActorGuard implements CanActivate, OnModuleInit {
  private readonly logger = new Logger(DevActorGuard.name);
  private readonly enabled: boolean;
  private readonly users: DevActorUserReader;

  constructor(
    private readonly reflector: Reflector,
    config: ConfigService,
    prisma: PrismaService,
  ) {
    this.enabled = isDevAuthEnabled({
      nodeEnv: config.get<unknown>('NODE_ENV'),
      devAuthEnabled: config.get<unknown>('DEV_AUTH_ENABLED'),
    });
    this.users = prisma;
  }

  onModuleInit(): void {
    if (this.enabled) {
      this.logger.warn(
        `DEV AUTH IS ENABLED: any caller can act as any user by sending the ${DEV_USER_HEADER} ` +
          'header. Development only; this must never be reachable from outside your machine.',
      );
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    if (!this.enabled) {
      // The header is deliberately not looked at on this path.
      throw ApiException.unauthenticated('Authentication is not available yet');
    }

    const header = context.switchToHttp().getRequest<RequestLike>().headers[DEV_USER_HEADER];
    if (header === undefined || header === '') {
      throw ApiException.unauthenticated(
        `Send the ${DEV_USER_HEADER} header with the id of the user to act as (development only)`,
      );
    }

    const parsed = idSchema.safeParse(header);
    if (!parsed.success) {
      throw ApiException.unauthenticated(
        `The ${DEV_USER_HEADER} header must be one user id (UUID)`,
      );
    }

    const user = await this.users.user.findUnique({
      where: { id: parsed.data },
      select: { id: true, organizationId: true, archivedAt: true },
    });
    if (!user || user.archivedAt !== null) {
      throw ApiException.unauthenticated(
        `The ${DEV_USER_HEADER} header does not name an active user`,
      );
    }

    RequestContext.setActor({ userId: user.id, organizationId: user.organizationId });
    return true;
  }
}
