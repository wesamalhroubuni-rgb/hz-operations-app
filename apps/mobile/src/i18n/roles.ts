import { roleLabel } from '@ops/shared';

import { t } from './index';

const KNOWN = ['worker', 'supervisor', 'manager', 'admin'] as const;

/**
 * The translated name of a role. A role this build does not know falls back to the shared
 * `roleLabel` (the role as sent, capitalised) instead of being hidden.
 */
export function roleName(role: string | null | undefined): string {
  if (!role) return t('roles.none');
  const known = KNOWN.find((candidate) => candidate === role);
  return known ? t(`roles.${known}`) : roleLabel(role);
}
