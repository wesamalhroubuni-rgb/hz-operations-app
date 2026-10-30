import {
  type ApiResult,
  createMembershipSchema,
  createUserSchema,
  ORG_WIDE_ROLES,
  updateUserSchema,
  type CreatedUser,
  type CreateMembershipInput,
  type CreateUserInput,
  type IssuedCode,
  type Locale,
  type Membership,
  type MembershipSummary,
  type Role,
  type UpdateMembership,
  type UpdateUserInput,
  type User,
  type UserFull,
} from '@ops/shared';

import { ApiCallError } from './api/errors';
import type { Capabilities } from './permissions';

/**
 * People screen logic (Phase 6, agent C). Admins manage users, codes, sessions and memberships;
 * managers view (`contact` profiles); supervisors do not open the page. Every user may change
 * their own display name and language. UX only: the API decides (ADR-0005).
 */

// ---- One-time codes ---------------------------------------------------------------------

/**
 * An activation or reset code as the dashboard shows it ONCE. It lives only in the state of the
 * dialog that shows it: never in the query cache, the URL, or browser storage. Closing the
 * dialog drops it, and there is no way to show it again (issue a new one instead).
 */
export interface OneTimeCode {
  purpose: IssuedCode['purpose'];
  /** Null outside development: delivery to the user is not built yet (ADR-0004). */
  code: string | null;
  link: string | null;
  expiresAt: string;
  /** Who it is for, for the dialog title. */
  userName: string;
}

export function oneTimeCodeOf(issued: IssuedCode, userName: string): OneTimeCode {
  return {
    purpose: issued.purpose,
    code: issued.code,
    link: issued.link,
    expiresAt: issued.expiresAt,
    userName,
  };
}

/**
 * Splits the answer of `POST /users` into the user (safe to cache) and the activation code
 * (shown once, never cached). The returned user has no `activation` key at all.
 */
export function splitCreatedUser(created: CreatedUser): { user: UserFull; code: OneTimeCode } {
  const { activation, ...user } = created;
  return { user, code: oneTimeCodeOf(activation, user.displayName) };
}

// ---- What the caller may do -------------------------------------------------------------

export type EditableUserField = 'displayName' | 'email' | 'phone' | 'username' | 'locale';

const ALL_FIELDS: readonly EditableUserField[] = [
  'displayName',
  'email',
  'phone',
  'username',
  'locale',
];

/** Admins change every field of anyone; everyone else only their own name and language. */
export function editableUserFields(
  capabilities: Capabilities,
  isSelf: boolean,
): readonly EditableUserField[] {
  if (capabilities.manageUsers) return ALL_FIELDS;
  if (isSelf) return ['displayName', 'locale'];
  return [];
}

export interface UserActions {
  invite: boolean;
  edit: boolean;
  issueActivationCode: boolean;
  resetPassword: boolean;
  archive: boolean;
  restore: boolean;
  sessions: boolean;
  memberships: boolean;
}

/** The page-level action (no user). */
export function canInvite(capabilities: Capabilities): boolean {
  return capabilities.manageUsers;
}

/**
 * Actions offered for one user. Codes need the full profile (`activated` is only in it).
 * An admin is not offered archiving themself (the API also refuses the last admin, 409).
 */
export function userActions(capabilities: Capabilities, user: User, isSelf: boolean): UserActions {
  const admin = capabilities.manageUsers;
  const full = user.profile === 'full' ? user : null;
  const archived = full?.archivedAt != null;
  return {
    invite: admin,
    edit: editableUserFields(capabilities, isSelf).length > 0 && !archived,
    issueActivationCode: admin && full !== null && !full.activated && !archived,
    resetPassword: admin && full !== null && full.activated && !archived,
    archive: admin && full !== null && !archived && !isSelf,
    restore: admin && full !== null && archived,
    sessions: admin && full !== null,
    memberships: admin && full !== null,
  };
}

// ---- User forms -------------------------------------------------------------------------

export interface UserFormState {
  displayName: string;
  email: string;
  phone: string;
  username: string;
  locale: Locale;
}

export function emptyUserForm(): UserFormState {
  return { displayName: '', email: '', phone: '', username: '', locale: 'en' };
}

export function userFormFrom(user: User): UserFormState {
  return {
    displayName: user.displayName,
    email: user.profile === 'basic' ? '' : (user.email ?? ''),
    phone: user.profile === 'basic' ? '' : (user.phone ?? ''),
    username: user.profile === 'full' ? (user.username ?? '') : '',
    locale: user.profile === 'full' ? user.locale : 'en',
  };
}

export type FormErrors = Record<string, string>;
export type BodyResult<Body> = { ok: true; body: Body } | { ok: false; errors: FormErrors };

function issuesToErrors(issues: readonly { path: PropertyKey[]; message: string }[]): FormErrors {
  const errors: FormErrors = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : 'form';
    errors[key] ??= issue.message;
  }
  return errors;
}

/** `POST /users`. Empty identifiers are left out; at least one is required (schema). */
export function createUserBody(form: UserFormState): BodyResult<CreateUserInput> {
  const body: CreateUserInput = {
    displayName: form.displayName.trim(),
    locale: form.locale,
    ...(form.email.trim() === '' ? {} : { email: form.email.trim() }),
    ...(form.phone.trim() === '' ? {} : { phone: form.phone.trim() }),
    ...(form.username.trim() === '' ? {} : { username: form.username.trim() }),
  };
  const parsed = createUserSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

/**
 * `PATCH /users/:id` with only the editable fields that changed (an empty identifier clears it:
 * `null`). `null` body when nothing changed.
 */
export function updateUserBody(
  user: User,
  form: UserFormState,
  editable: readonly EditableUserField[],
): BodyResult<UpdateUserInput | null> {
  const before = userFormFrom(user);
  const body: UpdateUserInput = {};
  for (const field of editable) {
    const value = form[field].trim();
    if (value === before[field].trim()) continue;
    if (field === 'locale') {
      body.locale = form.locale;
    } else if (field === 'displayName') {
      body.displayName = value;
    } else {
      body[field] = value === '' ? null : value;
    }
  }
  if (Object.keys(body).length === 0) {
    return { ok: true, body: null };
  }
  const parsed = updateUserSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

// ---- Memberships ------------------------------------------------------------------------

export interface MembershipFormState {
  role: Role;
  orgWide: boolean;
  siteIds: string[];
  teamIds: string[];
}

export function emptyMembershipForm(): MembershipFormState {
  return { role: 'worker', orgWide: false, siteIds: [], teamIds: [] };
}

export function membershipFormFrom(
  membership: MembershipSummary | Membership,
): MembershipFormState {
  return {
    role: membership.role,
    orgWide: membership.orgWide,
    siteIds: [...membership.siteIds],
    teamIds: [...membership.teamIds],
  };
}

/** Managers and admins always cover the whole organization: the scope pickers do not apply. */
export function roleIsOrgWide(role: Role): boolean {
  return ORG_WIDE_ROLES.includes(role);
}

/**
 * The membership as the API wants it (`membershipScopeIssues`): a manager or admin is
 * organization-wide with no sites or teams; an organization-wide worker or supervisor lists none
 * either. A worker or supervisor that is not organization-wide needs at least one site or team
 * (`scope` error): a membership without scope would grant nothing.
 */
export function membershipBody(form: MembershipFormState): BodyResult<{
  role: Role;
  orgWide: boolean;
  siteIds: string[];
  teamIds: string[];
}> {
  if (roleIsOrgWide(form.role)) {
    return { ok: true, body: { role: form.role, orgWide: true, siteIds: [], teamIds: [] } };
  }
  if (form.orgWide) {
    return { ok: true, body: { role: form.role, orgWide: true, siteIds: [], teamIds: [] } };
  }
  if (form.siteIds.length === 0 && form.teamIds.length === 0) {
    return { ok: false, errors: { scope: 'required' } };
  }
  return {
    ok: true,
    body: {
      role: form.role,
      orgWide: false,
      siteIds: [...form.siteIds],
      teamIds: [...form.teamIds],
    },
  };
}

export function createMembershipBody(
  userId: string,
  form: MembershipFormState,
): BodyResult<CreateMembershipInput> {
  const scoped = membershipBody(form);
  if (!scoped.ok) return scoped;
  const body: CreateMembershipInput = { userId, ...scoped.body };
  const parsed = createMembershipSchema.safeParse(body);
  return parsed.success
    ? { ok: true, body }
    : { ok: false, errors: issuesToErrors(parsed.error.issues) };
}

/** `PATCH /memberships/:id` sends the whole scope, so the stored lists are replaced exactly. */
export function updateMembershipBody(form: MembershipFormState): BodyResult<UpdateMembership> {
  return membershipBody(form);
}

// ---- Invite and code flows (no caching of codes) ----------------------------------------

export type CodeFlowOutcome =
  | { kind: 'done'; user: UserFull | null; code: OneTimeCode }
  | { kind: 'invalid'; errors: FormErrors }
  | { kind: 'failed'; error: unknown };

export interface PeopleCodeApi {
  create(body: CreateUserInput): Promise<ApiResult<CreatedUser>>;
  issueActivationCode(id: string): Promise<ApiResult<IssuedCode>>;
  issuePasswordReset(id: string): Promise<ApiResult<IssuedCode>>;
}

/**
 * `POST /users`. The answer's user may go into the query cache; its activation code goes only to
 * the caller, which shows it once. Deliberately not a TanStack mutation: a mutation keeps its
 * result (the code) in the mutation cache after the dialog closes.
 */
export async function inviteUser(
  api: PeopleCodeApi,
  form: UserFormState,
): Promise<CodeFlowOutcome> {
  const built = createUserBody(form);
  if (!built.ok) return { kind: 'invalid', errors: built.errors };
  const result = await api.create(built.body);
  if (!result.ok) return { kind: 'failed', error: new ApiCallError(result.failure) };
  const { user, code } = splitCreatedUser(result.data);
  return { kind: 'done', user, code };
}

/** A new activation code or a password-reset code for an existing user, shown once. */
export async function issueUserCode(
  api: PeopleCodeApi,
  user: Pick<User, 'id' | 'displayName'>,
  purpose: 'activation' | 'password_reset',
): Promise<CodeFlowOutcome> {
  const result =
    purpose === 'activation'
      ? await api.issueActivationCode(user.id)
      : await api.issuePasswordReset(user.id);
  if (!result.ok) return { kind: 'failed', error: new ApiCallError(result.failure) };
  return { kind: 'done', user: null, code: oneTimeCodeOf(result.data, user.displayName) };
}
