/**
 * The slices of the database client the auth module reads and writes through. They are
 * structural, so the module does not depend on the host's generated database types and a fake
 * can stand in for the database in unit tests.
 *
 * Host requirements (tables, as models of the database client):
 * - `user`: id, organizationId, email, phone, username, displayName, archivedAt. Identifiers are
 *   stored normalised (see ./identifiers.ts) and are unique within an organization.
 * - `organization`: id, slug, name, archivedAt.
 * - `authCredential`, `authOneTimeCode`, `authSession`, `authRefreshToken`: the platform's own
 *   tables (see the Authentication section of the schema).
 * - `auditEvent`: see `AuditWriter`.
 * - `$transaction(callback)` on the root client.
 */
import type { AuditWriter } from '../audit/audit.service';

export interface AuthUserRow {
  id: string;
  organizationId: string;
  email: string | null;
  phone: string | null;
  username: string | null;
  displayName: string;
  /** The user's language (Phase 6); optional so a host without the column still fits. */
  locale?: string | null;
  archivedAt: Date | null;
}

export interface AuthOrganizationRow {
  id: string;
  slug: string;
  name: string;
  archivedAt: Date | null;
}

export interface AuthCredentialRow {
  userId: string;
  organizationId: string;
  passwordHash: string;
  passwordChangedAt: Date;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
}

export type AuthCodePurposeValue = 'activation' | 'password_reset';

export interface AuthOneTimeCodeRow {
  id: string;
  userId: string;
  organizationId: string;
  purpose: AuthCodePurposeValue;
  codeHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  issuedById: string | null;
  createdAt: Date;
}

export type AuthClientValue = 'web' | 'mobile';

export interface AuthSessionRow {
  id: string;
  userId: string;
  organizationId: string;
  client: AuthClientValue;
  deviceName: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
}

export interface AuthRefreshTokenRow {
  id: string;
  sessionId: string;
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- query arguments are the ORM's own shapes;
   the rows that come back are what this module types. */
interface Reader<Row> {
  findUnique(args: any): PromiseLike<Row | null>;
  findFirst(args: any): PromiseLike<Row | null>;
  findMany(args: any): PromiseLike<Row[]>;
}

interface Writer<Row> extends Reader<Row> {
  create(args: any): PromiseLike<Row>;
  update(args: any): PromiseLike<Row>;
  updateMany(args: any): PromiseLike<{ count: number }>;
  upsert(args: any): PromiseLike<Row>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A database client or a transaction of it. */
export interface AuthTx extends AuditWriter {
  user: Reader<AuthUserRow>;
  organization: Reader<AuthOrganizationRow>;
  authCredential: Writer<AuthCredentialRow>;
  authOneTimeCode: Writer<AuthOneTimeCodeRow>;
  authSession: Writer<AuthSessionRow>;
  authRefreshToken: Writer<AuthRefreshTokenRow>;
}

/** The root database client: everything a transaction has, plus the ability to start one. */
export interface AuthDatabase extends AuthTx {
  $transaction<Result>(callback: (tx: AuthTx) => Promise<Result>): Promise<Result>;
}

export const AUTH_DATABASE = Symbol('platform.authDatabase');
