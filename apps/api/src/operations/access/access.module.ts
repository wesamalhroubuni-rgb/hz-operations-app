import { Global, Module } from '@nestjs/common';
import { AUTH_PROFILE_PROVIDER } from '../../platform/auth/auth-profile';
import { REQUEST_AUTHORIZER } from '../../platform/authz';
import { ScopeService } from '../scope/scope.service';
import { AccessService } from './access.service';
import { AccessClock } from './clock';
import { OperationsAuthProfileProvider } from './operations-auth-profile.provider';
import { OperationsRequestAuthorizer } from './operations-request-authorizer';

/**
 * The authorization layer of the Operations domain, for the whole application:
 *
 * - `REQUEST_AUTHORIZER`: the function-level check the platform's guard calls for every route
 *   that declares `@Policy(...)`, answered from the policy registry (`./policies`);
 * - `AccessService`: the caller's access context, resolved once per request, which services
 *   pass to the pure object-level rules in `./rules`;
 * - `AUTH_PROFILE_PROVIDER`: the organization name and roles the auth module shows a user.
 */
@Global()
@Module({
  providers: [
    ScopeService,
    AccessService,
    AccessClock,
    { provide: REQUEST_AUTHORIZER, useClass: OperationsRequestAuthorizer },
    { provide: AUTH_PROFILE_PROVIDER, useClass: OperationsAuthProfileProvider },
  ],
  exports: [ScopeService, AccessService, AccessClock, REQUEST_AUTHORIZER, AUTH_PROFILE_PROVIDER],
})
export class AccessModule {}
