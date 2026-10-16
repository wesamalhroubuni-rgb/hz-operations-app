import { hash, verify } from '@node-rs/argon2';

/**
 * argon2id with the parameters OWASP recommends as a minimum (19 MiB of memory, 2 passes, one
 * lane). The hash is a PHC string: algorithm, parameters and salt travel with it, so the
 * parameters can be raised later without invalidating stored hashes.
 */
const ARGON2_OPTIONS = {
  /** 2 = argon2id (the `Algorithm` const enum of the library cannot be imported as a value). */
  algorithm: 2,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

export interface PasswordHasherOptions {
  /** Overrides for tests that need hashing to be fast. Never used by the application. */
  memoryCost?: number;
  timeCost?: number;
}

/** Hashes and verifies passwords. No dependencies; `new PasswordHasher()` works anywhere. */
export class PasswordHasher {
  private readonly options: {
    algorithm: 2;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    outputLen: number;
  };
  private dummy: Promise<string> | null = null;

  constructor(options: PasswordHasherOptions = {}) {
    this.options = { ...ARGON2_OPTIONS, ...options };
  }

  hash(password: string): Promise<string> {
    return hash(password, this.options);
  }

  /** False for a wrong password and for a stored value that is not a valid hash. Never throws. */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }

  /**
   * Does the work of one verification and answers false. Called when there is no account or no
   * password to check, so the response time does not reveal whether the account exists.
   */
  async verifyAgainstNothing(password: string): Promise<false> {
    this.dummy ??= this.hash('no-account-placeholder');
    await this.verify(await this.dummy, password);
    return false;
  }
}
