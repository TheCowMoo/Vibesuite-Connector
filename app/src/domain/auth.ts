import { env } from '../config/env';
import { renderInviteEmail, DEFAULT_INVITE_TEMPLATE } from './inviteEmail';
import { resolveSystemEmailSettings } from './systemEmailSettings';
import { sendSystemEmail, type SystemEmailResult } from './systemEmail';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { randomToken, sha256 } from '../lib/tokens';
import { passwordProblems } from './passwordPolicy';
import { canAssignRole, canManageUser, roleDeniedMessage } from './userRoles';
import { renderPasswordResetEmail } from './passwordResetEmail';
import {
  countUsers,
  createInvite,
  createLogin,
  createUser,
  consumePasswordReset,
  deleteInvite,
  deleteLogin,
  deletePasswordReset,
  deletePasswordResetForUser,
  deleteUser,
  deleteUserLogins,
  findInviteByTokenHash,
  getInvite,
  getLogin,
  getLoginAttempts,
  getUser,
  getUserByEmail,
  listInvites,
  listUsers,
  bumpLoginAttempts,
  clearLoginAttempts,
  pushAudit,
  saveInvite,
  savePasswordReset,
  saveUser,
  type InviteRecord,
  type PasswordResetRecord,
  type UserRecord,
  type UserRole,
  type UserStatus,
} from './authStore';

const MAX_LOGIN_ATTEMPTS = 10;
const ATTEMPT_WINDOW_SECONDS = 900;

export function sessionTtlSeconds(): number {
  return env.SESSION_TTL_DAYS * 24 * 60 * 60;
}

export function inviteTtlSeconds(): number {
  return env.INVITE_TTL_DAYS * 24 * 60 * 60;
}

export function passwordResetTtlSeconds(): number {
  return env.PASSWORD_RESET_TTL_MINUTES * 60;
}

function assertPassword(password: string, context: { email?: string; name?: string } = {}): void {
  const problem = passwordProblems(password, context)[0];
  if (problem) throw new Error(problem);
}

export async function issueLogin(userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const rec = await createLogin(sha256(token), userId, sessionTtlSeconds());
  return { token, expiresAt: rec.expiresAt };
}

export async function resolveSession(token: string | null | undefined): Promise<UserRecord | null> {
  if (!token) return null;
  const rec = await getLogin(sha256(token));
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    await deleteLogin(rec.tokenHash);
    return null;
  }
  const user = await getUser(rec.userId);
  if (!user || user.status !== 'active') return null;
  return user;
}

export async function endSession(token: string | null | undefined): Promise<void> {
  if (!token) return;
  await deleteLogin(sha256(token));
}

export type LoginOutcome =
  | { ok: true; token: string; user: UserRecord }
  | { ok: false; error: string; status: number };

export async function loginWithPassword(email: string, password: string, ip?: string): Promise<LoginOutcome> {
  const emailLower = email.trim().toLowerCase();
  const attemptKey = `${emailLower}:${ip ?? 'unknown'}`;

  if ((await getLoginAttempts(attemptKey)) >= MAX_LOGIN_ATTEMPTS) {
    return { ok: false, error: 'too many attempts — try again later', status: 429 };
  }

  const user = await getUserByEmail(emailLower);
  const valid = user ? verifyPassword(password, user.passwordHash) : false;
  if (!user || !valid) {
    await bumpLoginAttempts(attemptKey, ATTEMPT_WINDOW_SECONDS);
    await pushAudit({ at: Date.now(), action: 'login_failed', detail: emailLower });
    return { ok: false, error: 'invalid email or password', status: 401 };
  }
  if (user.status !== 'active') return { ok: false, error: 'account disabled', status: 403 };

  await clearLoginAttempts(attemptKey);
  user.lastLoginAt = Date.now();
  await saveUser(user);
  const { token } = await issueLogin(user.id);
  await pushAudit({ at: Date.now(), actor: user.email, action: 'login' });
  return { ok: true, token, user };
}

export async function needsSetup(): Promise<boolean> {
  if (!env.AUTH_ENABLED || !env.AUTH_ALLOW_FIRST_RUN_SETUP) return false;
  return (await countUsers()) === 0;
}

export async function createOwner(input: { email: string; name: string; password: string }): Promise<UserRecord> {
  if ((await countUsers()) > 0) throw new Error('an owner already exists');
  assertPassword(input.password, { email: input.email, name: input.name });
  const user = await createUser({
    email: input.email,
    name: input.name || input.email,
    role: 'owner',
    status: 'active',
    passwordHash: hashPassword(input.password),
    createdBy: 'first-run-setup',
  });
  await pushAudit({ at: Date.now(), actor: user.email, action: 'owner_created' });
  return user;
}

export async function acceptInvite(token: string, name: string, password: string): Promise<UserRecord> {
  const invite = await findInviteByTokenHash(sha256(token));
  if (!invite) throw new Error('invalid invite link');
  if (invite.acceptedAt) throw new Error('this invite has already been used');
  if (invite.expiresAt < Date.now()) throw new Error('this invite has expired');
  if (await getUserByEmail(invite.emailLower)) throw new Error('an account with that email already exists');
  assertPassword(password, { email: invite.email, name: name || invite.name });

  const user = await createUser({
    email: invite.email,
    name: name || invite.name || invite.email,
    role: invite.role,
    status: 'active',
    passwordHash: hashPassword(password),
    createdBy: invite.invitedBy,
  });
  invite.acceptedAt = Date.now();
  await saveInvite(invite);
  await pushAudit({ at: Date.now(), actor: user.email, action: 'invite_accepted', detail: invite.emailLower });
  return user;
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
  const user = await getUser(userId);
  if (!user) throw new Error('user not found');
  if (!verifyPassword(currentPassword, user.passwordHash)) throw new Error('current password is incorrect');
  assertPassword(newPassword, { email: user.email, name: user.name });
  user.passwordHash = hashPassword(newPassword);
  user.passwordChangedAt = Date.now();
  await saveUser(user);
  await deleteUserLogins(userId);
  await pushAudit({ at: Date.now(), actor: user.email, action: 'password_changed' });
}

export function passwordResetUrlFor(token: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`;
}

async function deliverPasswordReset(
  user: UserRecord,
  resetUrl: string,
  expiresAt: number,
): Promise<SystemEmailResult> {
  const rendered = renderPasswordResetEmail({
    name: user.name,
    email: user.email,
    resetUrl,
    expiresAt: formatExpiryWithTime(expiresAt),
  });
  return sendSystemEmail({
    to: user.email,
    name: user.name,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}

async function issuePasswordReset(
  user: UserRecord,
  baseUrl: string,
  requestedIp?: string,
): Promise<{ token: string; resetUrl: string; expiresAt: number }> {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + passwordResetTtlSeconds() * 1000;
  const rec: PasswordResetRecord = {
    tokenHash: sha256(token),
    userId: user.id,
    emailLower: user.emailLower,
    issuedAt: now,
    expiresAt,
    ...(requestedIp ? { requestedIp } : {}),
  };
  await savePasswordReset(rec, passwordResetTtlSeconds());
  return { token, resetUrl: passwordResetUrlFor(token, baseUrl), expiresAt };
}

/**
 * Self-service request. Callers must return a generic response whether or not the account exists.
 */
export async function requestPasswordReset(
  email: string,
  baseUrl: string,
  requestedIp?: string,
): Promise<{ requested: boolean; delivery?: SystemEmailResult; expiresAt?: number }> {
  const user = await getUserByEmail(email);
  if (!user || user.status !== 'active') return { requested: false };

  const reset = await issuePasswordReset(user, baseUrl, requestedIp);
  await pushAudit({
    at: Date.now(),
    actor: user.email,
    action: 'password_reset_requested',
    detail: user.email,
  });
  const delivery = await deliverPasswordReset(user, reset.resetUrl, reset.expiresAt);
  return { requested: true, delivery, expiresAt: reset.expiresAt };
}

async function assertCanManage(actor: UserRecord, target: UserRecord): Promise<void> {
  if (actor.id === target.id) throw new Error('use the account menu to manage your own account');
  if (!canManageUser(actor.role, target.role)) throw new Error(roleDeniedMessage(actor.role));
}

/**
 * Admin-generated one-time link. The admin can copy it even when email delivery is unavailable;
 * the link itself is the credential and must be handled as sensitive.
 */
export async function createAdminPasswordReset(
  actor: UserRecord,
  userId: string,
  baseUrl: string,
  sendEmail: boolean,
): Promise<{
  resetUrl: string;
  expiresAt: number;
  delivery?: SystemEmailResult;
}> {
  const target = await getUser(userId);
  if (!target) throw new Error('user not found');
  await assertCanManage(actor, target);
  if (target.status !== 'active') throw new Error('enable the account before resetting its password');

  const reset = await issuePasswordReset(target, baseUrl);
  await pushAudit({
    at: Date.now(),
    actor: actor.email,
    action: 'password_reset_link_created',
    detail: target.email,
  });
  const delivery = sendEmail ? await deliverPasswordReset(target, reset.resetUrl, reset.expiresAt) : undefined;
  return {
    resetUrl: reset.resetUrl,
    expiresAt: reset.expiresAt,
    ...(delivery ? { delivery } : {}),
  };
}

export async function resetPassword(token: string, newPassword: string): Promise<UserRecord> {
  // Length is checked before consuming the link; a typo should not burn a valid reset.
  assertPassword(newPassword);
  const tokenHash = sha256(token);
  const rec = await consumePasswordReset(tokenHash);
  if (!rec) throw new Error('this reset link is invalid or has expired');
  if (rec.expiresAt < Date.now()) {
    await deletePasswordReset(tokenHash, rec.userId);
    throw new Error('this reset link is invalid or has expired');
  }

  const user = await getUser(rec.userId);
  if (!user || user.status !== 'active') throw new Error('this reset link is invalid or has expired');
  if (user.passwordChangedAt && rec.issuedAt <= user.passwordChangedAt) {
    await deletePasswordReset(tokenHash, rec.userId);
    throw new Error('this reset link is invalid or has expired');
  }

  assertPassword(newPassword, { email: user.email, name: user.name });
  user.passwordHash = hashPassword(newPassword);
  user.passwordChangedAt = Date.now();
  await saveUser(user);
  await deleteUserLogins(user.id);
  await deletePasswordReset(tokenHash, user.id);
  await pushAudit({ at: Date.now(), actor: user.email, action: 'password_reset_completed' });
  return user;
}

export async function revokeUserSessions(actor: UserRecord, userId: string): Promise<void> {
  const target = await getUser(userId);
  if (!target) throw new Error('user not found');
  await assertCanManage(actor, target);
  await deleteUserLogins(target.id);
  await pushAudit({
    at: Date.now(),
    actor: actor.email,
    action: 'sessions_revoked',
    detail: target.email,
  });
}

export interface InviteResult {
  invite: InviteRecord;
  inviteUrl: string;
  /** Which channel actually delivered it, and why if it did not. */
  webhook: SystemEmailResult;
}

export function inviteUrlFor(token: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/invite?token=${encodeURIComponent(token)}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** UTC day, so the wording in the email is stable regardless of the server's timezone. */
function formatExpiry(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'soon';
  return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Reset links are short-lived, so the email needs the time as well as the date. */
function formatExpiryWithTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return 'soon';
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatExpiry(ms)}, ${hh}:${mm} UTC`;
}

/**
 * Deliver a team invite.
 *
 * System email goes through GoHighLevel when configured (see `sendSystemEmail`), with the GHL
 * inbound webhook as the fallback. The webhook payload keeps its original shape, so workflows
 * already built against it keep working unchanged.
 */
export async function deliverInvite(invite: InviteRecord, inviteUrl: string): Promise<SystemEmailResult> {
  const settings = await resolveSystemEmailSettings();
  const template = {
    subject: settings.subjectTemplate || DEFAULT_INVITE_TEMPLATE.subject,
    body: settings.bodyTemplate || DEFAULT_INVITE_TEMPLATE.body,
  };

  const rendered = renderInviteEmail(template, {
    name: invite.name || invite.email,
    email: invite.email,
    role: invite.role,
    invitedBy: invite.invitedBy,
    expiresAt: formatExpiry(invite.expiresAt),
    inviteUrl,
  });

  return sendSystemEmail({
    to: invite.email,
    name: invite.name,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    webhookPayload: {
      type: 'team_invite',
      email: invite.email,
      name: invite.name ?? null,
      role: invite.role,
      inviteUrl,
      invitedBy: invite.invitedBy,
      expiresAt: new Date(invite.expiresAt).toISOString(),
      subject: rendered.subject,
      timestamp: new Date().toISOString(),
    },
  });
}

export async function createTeamInvite(input: {
  email: string;
  role: UserRole;
  name?: string;
  invitedBy: string;
  actorRole: UserRole;
  baseUrl: string;
}): Promise<InviteResult> {
  if (!canAssignRole(input.actorRole, input.role)) {
    throw new Error(
      input.actorRole === 'admin'
        ? 'admins can only invite members'
        : roleDeniedMessage(input.actorRole),
    );
  }
  if (await getUserByEmail(input.email)) throw new Error('a user with that email already exists');

  const token = randomToken(32);
  const invite = await createInvite({
    email: input.email,
    name: input.name,
    role: input.role,
    token,
    tokenHash: sha256(token),
    invitedBy: input.invitedBy,
    expiresAt: Date.now() + inviteTtlSeconds() * 1000,
  });

  const inviteUrl = inviteUrlFor(token, input.baseUrl);
  await pushAudit({ at: Date.now(), actor: input.invitedBy, action: 'invite_created', detail: invite.email });
  const webhook = await deliverInvite(invite, inviteUrl);
  return { invite, inviteUrl, webhook };
}

export async function listTeamInvites(
  baseUrl: string,
  viewerRole: UserRole = 'owner',
): Promise<Array<InviteRecord & { inviteUrl: string }>> {
  const invites = await listInvites();
  return invites
    .filter((i) => canManageUser(viewerRole, i.role))
    .map((i) => ({ ...i, inviteUrl: inviteUrlFor(i.token, baseUrl) }));
}

export async function revokeInvite(
  id: string,
  actor: Pick<UserRecord, 'email' | 'role'>,
): Promise<boolean> {
  const invite = await getInvite(id);
  if (!invite) return false;
  if (!canManageUser(actor.role, invite.role)) throw new Error(roleDeniedMessage(actor.role));
  await deleteInvite(id);
  await pushAudit({ at: Date.now(), actor: actor.email, action: 'invite_revoked', detail: invite.email });
  return true;
}

export async function resendInvite(
  id: string,
  baseUrl: string,
  actor: Pick<UserRecord, 'email' | 'role'>,
): Promise<InviteResult | null> {
  const invite = await getInvite(id);
  if (!invite) return null;
  if (!canManageUser(actor.role, invite.role)) throw new Error(roleDeniedMessage(actor.role));
  const inviteUrl = inviteUrlFor(invite.token, baseUrl);
  const webhook = await deliverInvite(invite, inviteUrl);
  await pushAudit({ at: Date.now(), actor: actor.email, action: 'invite_resent', detail: invite.email });
  return { invite, inviteUrl, webhook };
}

export async function setUserRole(
  actor: Pick<UserRecord, 'id' | 'email' | 'role'>,
  userId: string,
  role: UserRole,
): Promise<void> {
  const user = await getUser(userId);
  if (!user) throw new Error('user not found');
  if (actor.id === userId) throw new Error('you cannot change your own role');
  if (!canManageUser(actor.role, user.role) || !canAssignRole(actor.role, role)) {
    throw new Error(roleDeniedMessage(actor.role));
  }
  const users = await listUsers();
  if (user.role === 'owner' && role !== 'owner' && users.filter((u) => u.role === 'owner').length <= 1) {
    throw new Error('cannot demote the last owner');
  }
  user.role = role;
  await saveUser(user);
  // A link generated while this person was a member must not survive a promotion, or the admin who
  // generated it could reset the new owner/admin.
  await deletePasswordResetForUser(userId);
  await pushAudit({ at: Date.now(), actor: actor.email, action: 'role_changed', detail: `${user.email} → ${role}` });
}

export async function setUserStatus(
  actor: Pick<UserRecord, 'id' | 'email' | 'role'>,
  userId: string,
  status: UserStatus,
): Promise<void> {
  if (actor.id === userId) throw new Error('you cannot disable your own account');
  const user = await getUser(userId);
  if (!user) throw new Error('user not found');
  if (!canManageUser(actor.role, user.role)) throw new Error(roleDeniedMessage(actor.role));
  const users = await listUsers();
  if (
    status === 'disabled' &&
    user.role === 'owner' &&
    users.filter((u) => u.role === 'owner').length <= 1
  ) {
    throw new Error('cannot disable the last owner');
  }
  user.status = status;
  user.disabledAt = status === 'disabled' ? Date.now() : undefined;
  await saveUser(user);
  if (status === 'disabled') {
    await deleteUserLogins(userId);
    // A disabled account must not leave a live reset link behind; re-enabling it later would make
    // that old link valid again.
    await deletePasswordResetForUser(userId);
  }
  await pushAudit({ at: Date.now(), actor: actor.email, action: status === 'disabled' ? 'user_disabled' : 'user_enabled', detail: user.email });
}

export async function removeUser(
  actor: Pick<UserRecord, 'id' | 'email' | 'role'>,
  userId: string,
): Promise<void> {
  if (actor.id === userId) throw new Error('you cannot remove your own account');
  const user = await getUser(userId);
  if (!user) throw new Error('user not found');
  if (!canManageUser(actor.role, user.role)) throw new Error(roleDeniedMessage(actor.role));
  const users = await listUsers();
  if (user.role === 'owner' && users.filter((u) => u.role === 'owner').length <= 1) {
    throw new Error('cannot remove the last owner');
  }
  await deleteUserLogins(userId);
  await deleteUser(userId);
  await pushAudit({ at: Date.now(), actor: actor.email, action: 'user_removed', detail: user.email });
}

