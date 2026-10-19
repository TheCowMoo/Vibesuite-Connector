import { env } from '../config/env';
import { renderInviteEmail, DEFAULT_INVITE_TEMPLATE } from './inviteEmail';
import { resolveSystemEmailSettings } from './systemEmailSettings';
import { sendSystemEmail, type SystemEmailResult } from './systemEmail';
import { logger } from '../lib/logger';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { randomToken, sha256 } from '../lib/tokens';
import {
  countUsers,
  createInvite,
  createLogin,
  createUser,
  deleteInvite,
  deleteLogin,
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
  saveUser,
  type InviteRecord,
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
  user.passwordHash = hashPassword(newPassword);
  await saveUser(user);
  await deleteUserLogins(userId);
  await pushAudit({ at: Date.now(), actor: user.email, action: 'password_changed' });
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
  baseUrl: string;
}): Promise<InviteResult> {
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

export async function listTeamInvites(baseUrl: string): Promise<Array<InviteRecord & { inviteUrl: string }>> {
  const invites = await listInvites();
  return invites.map((i) => ({ ...i, inviteUrl: inviteUrlFor(i.token, baseUrl) }));
}

export async function revokeInvite(id: string): Promise<void> {
  await deleteInvite(id);
}

export async function resendInvite(id: string, baseUrl: string): Promise<InviteResult | null> {
  const invite = await getInvite(id);
  if (!invite) return null;
  const inviteUrl = inviteUrlFor(invite.token, baseUrl);
  const webhook = await deliverInvite(invite, inviteUrl);
  return { invite, inviteUrl, webhook };
}

export async function setUserRole(actorEmail: string, userId: string, role: UserRole): Promise<void> {
  const user = await getUser(userId);
  if (!user) throw new Error('user not found');
  const users = await listUsers();
  if (user.role === 'owner' && role !== 'owner' && users.filter((u) => u.role === 'owner').length <= 1) {
    throw new Error('cannot demote the last owner');
  }
  user.role = role;
  await saveUser(user);
  await pushAudit({ at: Date.now(), actor: actorEmail, action: 'role_changed', detail: `${user.email} → ${role}` });
}

export async function setUserStatus(actorEmail: string, actorId: string, userId: string, status: UserStatus): Promise<void> {
  if (actorId === userId) throw new Error('you cannot disable your own account');
  const user = await getUser(userId);
  if (!user) throw new Error('user not found');
  user.status = status;
  user.disabledAt = status === 'disabled' ? Date.now() : undefined;
  await saveUser(user);
  if (status === 'disabled') await deleteUserLogins(userId);
  await pushAudit({ at: Date.now(), actor: actorEmail, action: status === 'disabled' ? 'user_disabled' : 'user_enabled', detail: user.email });
}

export async function removeUser(actorEmail: string, actorId: string, userId: string): Promise<void> {
  if (actorId === userId) throw new Error('you cannot remove your own account');
  const user = await getUser(userId);
  if (!user) throw new Error('user not found');
  const users = await listUsers();
  if (user.role === 'owner' && users.filter((u) => u.role === 'owner').length <= 1) {
    throw new Error('cannot remove the last owner');
  }
  await deleteUserLogins(userId);
  await deleteUser(userId);
  await pushAudit({ at: Date.now(), actor: actorEmail, action: 'user_removed', detail: user.email });
}

