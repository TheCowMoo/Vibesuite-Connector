import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

export type UserRole = 'owner' | 'admin' | 'member';
export type UserStatus = 'active' | 'disabled';

export interface UserRecord {
  id: string;
  email: string;
  emailLower: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  passwordHash: string;
  createdAt: number;
  createdBy?: string;
  lastLoginAt?: number;
  disabledAt?: number;
}

export interface InviteRecord {
  id: string;
  email: string;
  emailLower: string;
  name?: string;
  role: UserRole;
  /** Raw token kept so admins can re-copy a pending invite link. */
  token: string;
  tokenHash: string;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
}

export interface LoginRecord {
  tokenHash: string;
  userId: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuditEvent {
  at: number;
  actor?: string;
  action: string;
  detail?: string;
}

export function publicUser(u: UserRecord): Omit<UserRecord, 'passwordHash' | 'emailLower'> {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    createdBy: u.createdBy,
    lastLoginAt: u.lastLoginAt,
    disabledAt: u.disabledAt,
  };
}

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/* ---------------- Users ---------------- */

export async function countUsers(): Promise<number> {
  return redis.scard(REDIS_KEYS.authUsers());
}

export async function createUser(
  input: Omit<UserRecord, 'id' | 'createdAt' | 'emailLower'>
): Promise<UserRecord> {
  const rec: UserRecord = {
    ...input,
    emailLower: input.email.trim().toLowerCase(),
    id: randomUUID(),
    createdAt: Date.now(),
  };
  await redis
    .multi()
    .sadd(REDIS_KEYS.authUsers(), rec.id)
    .set(REDIS_KEYS.authUser(rec.id), JSON.stringify(rec))
    .set(REDIS_KEYS.authEmail(rec.emailLower), rec.id)
    .exec();
  return rec;
}

export async function getUser(id: string): Promise<UserRecord | null> {
  return readJson<UserRecord>(REDIS_KEYS.authUser(id));
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const id = await redis.get(REDIS_KEYS.authEmail(email.trim().toLowerCase()));
  return id ? getUser(id) : null;
}

export async function saveUser(rec: UserRecord): Promise<void> {
  await redis
    .multi()
    .set(REDIS_KEYS.authUser(rec.id), JSON.stringify(rec))
    .set(REDIS_KEYS.authEmail(rec.emailLower), rec.id)
    .exec();
}

export async function listUsers(): Promise<UserRecord[]> {
  const ids = await redis.smembers(REDIS_KEYS.authUsers());
  const recs = await Promise.all(ids.map((id) => getUser(id)));
  return recs.filter((u): u is UserRecord => u !== null).sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteUser(id: string): Promise<void> {
  const rec = await getUser(id);
  const multi = redis.multi().srem(REDIS_KEYS.authUsers(), id).del(REDIS_KEYS.authUser(id)).del(REDIS_KEYS.authLogins(id));
  if (rec) multi.del(REDIS_KEYS.authEmail(rec.emailLower));
  await multi.exec();
}

/* ---------------- Invites ---------------- */

export async function createInvite(
  input: Omit<InviteRecord, 'id' | 'createdAt' | 'emailLower'>
): Promise<InviteRecord> {
  const rec: InviteRecord = {
    ...input,
    emailLower: input.email.trim().toLowerCase(),
    id: randomUUID(),
    createdAt: Date.now(),
  };
  await redis
    .multi()
    .sadd(REDIS_KEYS.authInvites(), rec.id)
    .set(REDIS_KEYS.authInvite(rec.id), JSON.stringify(rec))
    .exec();
  return rec;
}

export async function getInvite(id: string): Promise<InviteRecord | null> {
  return readJson<InviteRecord>(REDIS_KEYS.authInvite(id));
}

export async function saveInvite(rec: InviteRecord): Promise<void> {
  await redis.set(REDIS_KEYS.authInvite(rec.id), JSON.stringify(rec));
}

export async function listInvites(): Promise<InviteRecord[]> {
  const ids = await redis.smembers(REDIS_KEYS.authInvites());
  const recs = await Promise.all(ids.map((id) => getInvite(id)));
  return recs.filter((i): i is InviteRecord => i !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export async function findInviteByTokenHash(tokenHash: string): Promise<InviteRecord | null> {
  const invites = await listInvites();
  return invites.find((i) => i.tokenHash === tokenHash) ?? null;
}

export async function deleteInvite(id: string): Promise<void> {
  await redis.multi().srem(REDIS_KEYS.authInvites(), id).del(REDIS_KEYS.authInvite(id)).exec();
}

/* ---------------- Logins (auth sessions) ---------------- */

export async function createLogin(tokenHash: string, userId: string, ttlSeconds: number): Promise<LoginRecord> {
  const now = Date.now();
  const rec: LoginRecord = { tokenHash, userId, createdAt: now, expiresAt: now + ttlSeconds * 1000 };
  await redis
    .multi()
    .set(REDIS_KEYS.authSession(tokenHash), JSON.stringify(rec), 'EX', ttlSeconds)
    .sadd(REDIS_KEYS.authLogins(userId), tokenHash)
    .expire(REDIS_KEYS.authLogins(userId), ttlSeconds)
    .exec();
  return rec;
}

export async function getLogin(tokenHash: string): Promise<LoginRecord | null> {
  return readJson<LoginRecord>(REDIS_KEYS.authSession(tokenHash));
}

export async function deleteLogin(tokenHash: string): Promise<void> {
  const rec = await getLogin(tokenHash);
  const multi = redis.multi().del(REDIS_KEYS.authSession(tokenHash));
  if (rec) multi.srem(REDIS_KEYS.authLogins(rec.userId), tokenHash);
  await multi.exec();
}

export async function deleteUserLogins(userId: string): Promise<void> {
  const tokens = await redis.smembers(REDIS_KEYS.authLogins(userId));
  if (!tokens.length) return;
  const multi = redis.multi();
  for (const t of tokens) multi.del(REDIS_KEYS.authSession(t));
  multi.del(REDIS_KEYS.authLogins(userId));
  await multi.exec();
}

/* ---------------- Login rate limiting ---------------- */

export async function getLoginAttempts(key: string): Promise<number> {
  const v = await redis.get(REDIS_KEYS.authLoginAttempts(key));
  return v ? Number(v) : 0;
}

export async function bumpLoginAttempts(key: string, ttlSeconds: number): Promise<number> {
  const n = await redis.incr(REDIS_KEYS.authLoginAttempts(key));
  if (n === 1) await redis.expire(REDIS_KEYS.authLoginAttempts(key), ttlSeconds);
  return n;
}

export async function clearLoginAttempts(key: string): Promise<void> {
  await redis.del(REDIS_KEYS.authLoginAttempts(key));
}

/* ---------------- Audit log ---------------- */

export async function pushAudit(ev: AuditEvent): Promise<void> {
  await redis
    .multi()
    .lpush(REDIS_KEYS.authAudit(), JSON.stringify(ev))
    .ltrim(REDIS_KEYS.authAudit(), 0, 499)
    .exec();
}

export async function listAudit(limit = 100): Promise<AuditEvent[]> {
  const raw = await redis.lrange(REDIS_KEYS.authAudit(), 0, limit - 1);
  return raw
    .map((r) => {
      try {
        return JSON.parse(r) as AuditEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is AuditEvent => e !== null);
}

