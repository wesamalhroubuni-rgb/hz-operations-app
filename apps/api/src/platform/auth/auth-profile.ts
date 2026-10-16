/**
 * How the platform auth module learns what the host application knows about a user beyond their
 * identity: the organization's name and the roles they hold. The auth module knows nothing about
 * memberships; the host provides this from a GLOBAL module, and the auth module injects it.
 *
 * CONTRACT: the token and the interface are fixed.
 */
export const AUTH_PROFILE_PROVIDER = Symbol('platform.authProfileProvider');

export interface AuthProfile {
  organizationName: string;
  /** Every role held through an active membership, highest first. */
  roles: string[];
  /** The highest role, or null when the user holds none. */
  role: string | null;
}

export interface AuthProfileProvider {
  describe(user: { userId: string; organizationId: string }): Promise<AuthProfile>;
}
