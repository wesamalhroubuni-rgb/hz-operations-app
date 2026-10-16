import type { AuthCodePurposeValue, AuthOneTimeCodeRow, AuthTx } from './auth-db';
import type { AuthSettings } from './auth-settings';
import type { Clock, RandomSource } from './clock';
import { sha256Hex } from './hashing';

/**
 * One-time codes for setting a password (activation and reset).
 *
 * Format: 16 characters from a 32-character alphabet (80 bits), shown as `XXXX-XXXX-XXXX-XXXX`.
 * The alphabet has no 0, 1, I or O, so a code read aloud or copied by hand is unambiguous. A
 * typed code is accepted in any letter case, with or without the dashes or spaces.
 *
 * Only the SHA-256 of the code is stored. Looking a code up is a lookup of its hash on a unique
 * index, so the comparison does not leak how much of a guess was right. A code works once and
 * only until it expires; issuing a new one for the same user and purpose cancels the earlier
 * unused ones.
 */

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 16;
const CODE_GROUP = 4;

/** The code as stored and hashed: upper-case, alphabet characters only. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** True when a typed value can be a code at all (right length and alphabet, once normalised). */
export function isWellFormedCode(raw: string): boolean {
  const normalized = normalizeCode(raw);
  return (
    normalized.length === CODE_LENGTH &&
    [...normalized].every((char) => CODE_ALPHABET.includes(char))
  );
}

/** `ABCDEFGHJKLMNPQR` -> `ABCD-EFGH-JKLM-NPQR`. */
export function formatCode(normalized: string): string {
  return normalized.match(new RegExp(`.{1,${CODE_GROUP}}`, 'g'))?.join('-') ?? normalized;
}

/** A new random code, formatted. Each byte gives 5 unbiased bits (256 is a multiple of 32). */
export function generateCode(random: RandomSource): string {
  const bytes = random.bytes(CODE_LENGTH);
  let code = '';
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte & 31];
  }
  return formatCode(code);
}

export function hashCode(raw: string): string {
  return sha256Hex(normalizeCode(raw));
}

export interface IssueCodeArgs {
  userId: string;
  organizationId: string;
  purpose: AuthCodePurposeValue;
  issuedById: string | null;
}

export interface NewCode {
  id: string;
  /** In clear, formatted. Exists only in memory, only now. */
  code: string;
  expiresAt: Date;
}

export class OneTimeCodes {
  constructor(
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly settings: Pick<AuthSettings, 'activationCodeTtlMs' | 'resetCodeTtlMs'>,
  ) {}

  /** Cancels the earlier unused codes of the same user and purpose, then stores a new one. */
  async issue(tx: AuthTx, args: IssueCodeArgs): Promise<NewCode> {
    const now = this.clock.now();
    await tx.authOneTimeCode.updateMany({
      where: { userId: args.userId, purpose: args.purpose, consumedAt: null },
      data: { consumedAt: now },
    });
    const code = generateCode(this.random);
    const ttl =
      args.purpose === 'activation'
        ? this.settings.activationCodeTtlMs
        : this.settings.resetCodeTtlMs;
    const expiresAt = new Date(now.getTime() + ttl);
    const row = await tx.authOneTimeCode.create({
      data: {
        userId: args.userId,
        organizationId: args.organizationId,
        purpose: args.purpose,
        codeHash: hashCode(code),
        expiresAt,
        issuedById: args.issuedById,
        createdAt: now,
      },
    });
    return { id: row.id, code, expiresAt };
  }

  /** The stored code a typed value names, if it can still be used; null otherwise. */
  async findUsable(tx: AuthTx, raw: string): Promise<AuthOneTimeCodeRow | null> {
    if (!isWellFormedCode(raw)) {
      return null;
    }
    const row = await tx.authOneTimeCode.findUnique({ where: { codeHash: hashCode(raw) } });
    if (!row || row.consumedAt !== null || row.expiresAt.getTime() <= this.clock.now().getTime()) {
      return null;
    }
    return row;
  }

  /**
   * Uses the code up. True for exactly one caller, however many redeem it at the same moment:
   * the update only matches a code that is still unused and unexpired.
   */
  async consume(tx: AuthTx, id: string): Promise<boolean> {
    const now = this.clock.now();
    const { count } = await tx.authOneTimeCode.updateMany({
      where: { id, consumedAt: null, expiresAt: { gt: now } },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  /** Cancels every unused code of a user (after the password was set by any means). */
  async cancelAllFor(tx: AuthTx, userId: string): Promise<number> {
    const { count } = await tx.authOneTimeCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: this.clock.now() },
    });
    return count;
  }
}
