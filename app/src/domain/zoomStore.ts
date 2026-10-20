import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';
import { seal, open } from '../lib/crypto';

export type ZoomAuthMode = 's2s' | 'user';

/**
 * One authorised Zoom host, shared by every campaign that picks it.
 *
 * This deliberately does **not** hang off a Google account: a campaign is what has one webinar and
 * one host, and it may send invitations from several mailboxes. Authorising a host once makes it
 * reusable, instead of copying tokens per campaign (which would multiply refresh cycles and let the
 * copies drift).
 */
export interface ZoomAccountRecord {
  userId: string;
  email: string;
  displayName?: string;
  connectedAt: number;
  /**
   * What Zoom actually allowed. A user-managed app authorised by a non-admin host cannot read
   * `/report/*`; attendance still syncs from the past-meetings API, but polls, Q&A and the absentee
   * list are unavailable. Caching the answer stops us probing on every sync and lets the UI explain
   * the empty sections.
   */
  reportAccess: 'granted' | 'denied' | 'unknown';
}

export interface ZoomTokenRecord {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export async function listZoomAccounts(): Promise<ZoomAccountRecord[]> {
  const ids = await redis.smembers(REDIS_KEYS.zoomAccountsIndex());
  const records = await Promise.all(ids.map((id) => getZoomAccount(id)));
  return records
    .filter((r): r is ZoomAccountRecord => r !== null)
    .sort((a, b) => a.email.localeCompare(b.email));
}

export async function getZoomAccount(userId: string): Promise<ZoomAccountRecord | null> {
  const raw = await redis.get(REDIS_KEYS.zoomAccount(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ZoomAccountRecord;
  } catch {
    return null;
  }
}

export async function saveZoomAccount(record: ZoomAccountRecord): Promise<void> {
  await redis
    .multi()
    .sadd(REDIS_KEYS.zoomAccountsIndex(), record.userId)
    .set(REDIS_KEYS.zoomAccount(record.userId), JSON.stringify(record))
    .exec();
}

export async function getZoomTokens(userId: string): Promise<ZoomTokenRecord | null> {
  const raw = await redis.get(REDIS_KEYS.zoomAccountTokens(userId));
  if (!raw) return null;
  try {
    return JSON.parse(open(raw, env.CREDENTIALS_ENCRYPTION_KEY)) as ZoomTokenRecord;
  } catch {
    return null;
  }
}

export async function saveZoomTokens(userId: string, tokens: ZoomTokenRecord): Promise<void> {
  await redis.set(REDIS_KEYS.zoomAccountTokens(userId), seal(JSON.stringify(tokens), env.CREDENTIALS_ENCRYPTION_KEY));
}

/** Tokens for every known host, so the pure selector can decide from one snapshot. */
export async function loadZoomTokens(accounts: ZoomAccountRecord[]): Promise<Record<string, ZoomTokenRecord>> {
  const entries = await Promise.all(
    accounts.map(async (a) => [a.userId, await getZoomTokens(a.userId)] as const),
  );
  const out: Record<string, ZoomTokenRecord> = {};
  for (const [userId, tokens] of entries) {
    if (tokens) out[userId] = tokens;
  }
  return out;
}

export async function deleteZoomAccount(userId: string): Promise<void> {
  await redis
    .multi()
    .srem(REDIS_KEYS.zoomAccountsIndex(), userId)
    .del(REDIS_KEYS.zoomAccount(userId))
    .del(REDIS_KEYS.zoomAccountTokens(userId))
    .exec();
}

/**
 * Drop only the credentials, keeping the account listed.
 *
 * That is what a revoked authorisation needs: the campaign should keep pointing at the host it was
 * configured with, and the error then says "reconnect this host" instead of silently falling back to
 * another identity.
 */
export async function deleteZoomTokens(userId: string): Promise<void> {
  await redis.del(REDIS_KEYS.zoomAccountTokens(userId));
}
