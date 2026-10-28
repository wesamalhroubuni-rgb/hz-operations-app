import type { Text } from '../logic/sync';
import { t } from './index';

/** Renders a `Text` of the sync logic (`src/logic/sync.ts`), translating nested keys first. */
export function syncText(text: Text): string {
  const nested: Record<string, string> = {};
  for (const [name, key] of Object.entries(text.nested ?? {})) nested[name] = t(key);
  return t(text.key, { ...text.params, ...nested });
}
