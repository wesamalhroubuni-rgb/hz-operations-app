import type { WriteError, WriteErrorKind } from '../data/results';
import { t } from './index';

/** The sentence a screen shows for a failed read or write. */
export function errorText(error: WriteError | WriteErrorKind): string {
  const kind = typeof error === 'string' ? error : error.kind;
  return t(`errors.${kind}`);
}
