import { randomBytes } from 'node:crypto';

/** Where the auth module reads the time, so tests can move it. */
export interface Clock {
  now(): Date;
}

export const AUTH_CLOCK = Symbol('platform.authClock');

export const systemClock: Clock = { now: () => new Date() };

/** Where the auth module gets random bytes, so tests can make tokens and codes predictable. */
export interface RandomSource {
  bytes(length: number): Buffer;
}

export const AUTH_RANDOM = Symbol('platform.authRandom');

export const systemRandom: RandomSource = { bytes: (length) => randomBytes(length) };
