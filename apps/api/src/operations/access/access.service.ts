import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { ApiException, requireActor } from '../../platform/http';
import {
  RequestContext,
  type RequestContextStore,
} from '../../platform/request-context/request-context';
import { ScopeService } from '../scope/scope.service';
import { buildAccessContext, systemAccessContext, type AccessContext } from './access-context';

interface CachedContext {
  userId: string;
  organizationId: string;
  context: Promise<AccessContext>;
}

/**
 * The one way a service learns who is asking and what they may see.
 *
 * `context()` resolves the caller's access context (roles and resolved scope) from the actor
 * the platform's guard put on the request, ONCE per request: the result is cached against the
 * request's context store, so the route-level check and every service call of the same request
 * share one resolution (four small queries). Nothing is cached across requests, so a membership
 * change applies to the very next request.
 *
 * Fail closed: no actor is a 401; an actor whose user is gone or archived is a 401.
 */
@Injectable()
export class AccessService {
  private readonly cache = new WeakMap<RequestContextStore, CachedContext>();
  /** The context of `runAsSystem` / `runAsUser` (code without a signed-in request). */
  private readonly backgroundContext = new AsyncLocalStorage<AccessContext>();

  constructor(private readonly scope: ScopeService) {}

  /** The access context of the current request. Throws 401 when nobody is signed in. */
  async context(): Promise<AccessContext> {
    const background = this.backgroundContext.getStore();
    const store = RequestContext.current();
    // A background context applies outside a request, and inside a context without an acting
    // user (an outbox handler runs in one, for its correlation id). Never inside a signed-in
    // request: there the caller's own context always wins.
    if (background && !store?.actor) {
      return background;
    }
    const actor = requireActor();
    if (!store) {
      throw ApiException.unauthenticated('This request has no acting user');
    }

    const cached = this.cache.get(store);
    if (
      cached &&
      cached.userId === actor.userId &&
      cached.organizationId === actor.organizationId
    ) {
      return cached.context;
    }
    const context = this.resolve(actor.organizationId, actor.userId);
    this.cache.set(store, { ...actor, context });
    // A failed resolution must not stay cached for the rest of the request.
    context.catch(() => {
      if (this.cache.get(store)?.context === context) {
        this.cache.delete(store);
      }
    });
    return context;
  }

  /**
   * Runs `work` with an admin's rights over one organization and no signed-in user. For code
   * that runs without a request (the seed). It cannot be used to raise the rights of a request:
   * inside a request context it throws, and `context()` ignores it there.
   */
  runAsSystem<Result>(organizationId: string, work: () => Promise<Result>): Promise<Result> {
    if (RequestContext.actor()) {
      throw new Error('AccessService.runAsSystem cannot be called inside a request');
    }
    return this.backgroundContext.run(systemAccessContext(organizationId), work);
  }

  /**
   * Runs `work` with exactly what one user may SEE, without a request (Phase 7, ADR-0011): the
   * daily-summary job computes a recipient's summary through the same services and visibility
   * filters as the dashboard, under the recipient's real scope (resolved now, fail closed).
   * Read-only: the context is marked `readOnly`, so `authorOf` refuses it and nothing can be
   * written as that user; the job writes its own rows under `runAsSystem`. Like `runAsSystem`,
   * it throws inside a signed-in request. An archived user or one without an active membership
   * is refused (401), so a summary is never computed for someone who lost access.
   */
  async runAsUser<Result>(
    organizationId: string,
    userId: string,
    work: () => Promise<Result>,
  ): Promise<Result> {
    if (RequestContext.actor()) {
      throw new Error('AccessService.runAsUser cannot be called inside a request');
    }
    const context: AccessContext = {
      ...(await this.resolve(organizationId, userId)),
      readOnly: true,
    };
    return this.backgroundContext.run(context, work);
  }

  private async resolve(organizationId: string, userId: string): Promise<AccessContext> {
    let context: AccessContext;
    try {
      context = buildAccessContext(await this.scope.resolveForUser(organizationId, userId));
    } catch (error) {
      if (error instanceof ApiException && error.code === 'not_found') {
        throw ApiException.unauthenticated('This request has no acting user');
      }
      throw error;
    }
    if (!context.scope.active) {
      throw ApiException.unauthenticated('This request has no acting user');
    }
    return context;
  }
}
