/**
 * TEMPORARY (removed when real sign-in lands in Phase 3).
 *
 * The single decision of whether the development-only acting-user header is honoured. It is a
 * pure function so the whole truth table can be tested, and it is deliberately strict:
 *
 *   NODE_ENV        DEV_AUTH_ENABLED   result
 *   'development'   true (boolean)     true
 *   anything else   anything           false
 *   anything        anything else      false   (including the string 'true', 1, undefined)
 *
 * Unknown, missing or oddly typed configuration therefore always means "off".
 */
export interface DevAuthConfig {
  nodeEnv: unknown;
  devAuthEnabled: unknown;
}

export function isDevAuthEnabled(config: DevAuthConfig): boolean {
  return config.nodeEnv === 'development' && config.devAuthEnabled === true;
}
