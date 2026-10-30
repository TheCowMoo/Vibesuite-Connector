import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { Campaign, RecipientRecord } from './campaign';

async function readJson<T>(key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function createCampaign(input: Omit<Campaign, 'id' | 'createdAt'>): Promise<Campaign> {
  const rec: Campaign = { ...input, id: randomUUID(), createdAt: Date.now() };
  await redis
    .multi()
    .sadd(REDIS_KEYS.campaignsIndex(), rec.id)
    .set(REDIS_KEYS.campaign(rec.id), JSON.stringify(rec))
    .exec();
  return rec;
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  return readJson<Campaign>(REDIS_KEYS.campaign(id));
}

export async function saveCampaign(rec: Campaign): Promise<void> {
  await redis.set(REDIS_KEYS.campaign(rec.id), JSON.stringify(rec));
}

export async function listCampaigns(): Promise<Campaign[]> {
  const ids = await redis.smembers(REDIS_KEYS.campaignsIndex());
  const recs = await Promise.all(ids.map((id) => getCampaign(id)));
  return recs.filter((c): c is Campaign => c !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteCampaign(id: string): Promise<void> {
  const rec = await getCampaign(id);
  const multi = redis
    .multi()
    .srem(REDIS_KEYS.campaignsIndex(), id)
    .del(REDIS_KEYS.campaign(id))
    .del(REDIS_KEYS.campaignRecipients(id))
    .del(REDIS_KEYS.campaignVariantMap(id));
  if (rec) {
    for (const s of rec.senders) {
      multi.del(REDIS_KEYS.campaignQueue(id, s.connectionId)).del(REDIS_KEYS.campaignSender(id, s.connectionId));
    }
  }
  await multi.exec();
}

/* ---------------- recipients ---------------- */

export async function setRecipients(id: string, records: RecipientRecord[]): Promise<void> {
  if (!records.length) return;
  const key = REDIS_KEYS.campaignRecipients(id);
  const multi = redis.multi();
  for (const r of records) multi.hset(key, r.email, JSON.stringify(r));
  await multi.exec();
}

export async function saveRecipient(id: string, rec: RecipientRecord): Promise<void> {
  await redis.hset(REDIS_KEYS.campaignRecipients(id), rec.email, JSON.stringify(rec));
}

export async function getRecipients(id: string): Promise<RecipientRecord[]> {
  const raw = await redis.hgetall(REDIS_KEYS.campaignRecipients(id));
  return Object.values(raw || {})
    .map((v) => {
      try {
        return JSON.parse(v) as RecipientRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is RecipientRecord => r !== null);
}

export async function countRecipients(id: string): Promise<{ total: number; pending: number; sent: number; failed: number }> {
  const recs = await getRecipients(id);
  const out = { total: recs.length, pending: 0, sent: 0, failed: 0 };
  for (const r of recs) {
    if (r.status === 'sent') out.sent += 1;
    else if (r.status === 'failed') out.failed += 1;
    else out.pending += 1;
  }
  return out;
}

/* ---------------- per-sender queues ---------------- */

export async function pushQueue(id: string, connectionId: string, emails: string[]): Promise<void> {
  if (!emails.length) return;
  await redis.rpush(REDIS_KEYS.campaignQueue(id, connectionId), ...emails);
}

/** Put emails back at the front (used when a mailbox cools down mid-send). */
export async function requeueFront(id: string, connectionId: string, emails: string[]): Promise<void> {
  if (!emails.length) return;
  await redis.lpush(REDIS_KEYS.campaignQueue(id, connectionId), ...[...emails].reverse());
}

export async function popQueue(id: string, connectionId: string, n: number): Promise<string[]> {
  if (n <= 0) return [];
  const key = REDIS_KEYS.campaignQueue(id, connectionId);
  const len = await redis.llen(key);
  if (!len) return [];

  const take = Math.min(n, len);
  const pipe = redis.pipeline();
  for (let i = 0; i < take; i += 1) pipe.lpop(key);
  const res = (await pipe.exec()) || [];
  return res.map((r) => (r && r[1] != null ? String(r[1]) : '')).filter(Boolean);
}

export async function queueLength(id: string, connectionId: string): Promise<number> {
  return redis.llen(REDIS_KEYS.campaignQueue(id, connectionId));
}

/* ---------------- counters + idempotency ---------------- */

export async function bumpCampaignSender(id: string, connectionId: string, field: 'sent' | 'failed', by = 1): Promise<void> {
  await redis.hincrby(REDIS_KEYS.campaignSender(id, connectionId), field, by);
}

export async function getCampaignSender(id: string, connectionId: string): Promise<{ sent: number; failed: number }> {
  const h = await redis.hgetall(REDIS_KEYS.campaignSender(id, connectionId));
  return { sent: Number(h?.sent ?? 0) || 0, failed: Number(h?.failed ?? 0) || 0 };
}

/** A recipient may only ever be sent once per campaign. */
export async function tryClaimRecipient(id: string, email: string): Promise<boolean> {
  const res = await redis.set(REDIS_KEYS.campaignDispatched(id, email), '1', 'EX', 60 * 60 * 24 * 30, 'NX');
  return res === 'OK';
}

export async function releaseRecipient(id: string, email: string): Promise<void> {
  await redis.del(REDIS_KEYS.campaignDispatched(id, email));
}

export async function clearCampaignQueues(id: string, connectionIds: string[]): Promise<void> {
  if (!connectionIds.length) return;
  const multi = redis.multi();
  for (const c of connectionIds) multi.del(REDIS_KEYS.campaignQueue(id, c));
  await multi.exec();
}

export async function resetCampaignCounters(id: string, connectionIds: string[]): Promise<void> {
  if (!connectionIds.length) return;
  const multi = redis.multi();
  for (const c of connectionIds) multi.del(REDIS_KEYS.campaignSender(id, c));
  await multi.exec();
}

export async function clearRecipients(id: string): Promise<void> {
  await redis.del(REDIS_KEYS.campaignRecipients(id));
}

/* ---------------- copy variants + test events ---------------- */

/** email -> A/B/C/D, written once when the audience is frozen. */
export async function setCampaignVariantMap(id: string, map: Record<string, string>): Promise<void> {
  const entries = Object.entries(map);
  if (!entries.length) return;
  const multi = redis.multi();
  for (const [email, variant] of entries) {
    multi.hset(REDIS_KEYS.campaignVariantMap(id), email.trim().toLowerCase(), variant);
  }
  await multi.exec();
}

export async function getCampaignVariantMap(id: string, emails: string[]): Promise<Record<string, string>> {
  if (!emails.length) return {};
  const keys = emails.map((email) => email.trim().toLowerCase());
  const values = await redis.hmget(REDIS_KEYS.campaignVariantMap(id), ...keys);
  const out: Record<string, string> = {};
  keys.forEach((email, index) => {
    const variant = values[index];
    if (variant) out[email] = variant;
  });
  return out;
}

export async function clearCampaignVariantMap(id: string): Promise<void> {
  await redis.del(REDIS_KEYS.campaignVariantMap(id));
}

/**
 * Remember a test-copy event so the RSVP pipeline can ignore it. A test invite is a real calendar
 * event, so without this its responses could create or update a GHL contact.
 */
export async function markCampaignTestEvent(connectionId: string, eventId: string): Promise<void> {
  if (!eventId) return;
  await redis.set(REDIS_KEYS.campaignTestEvent(connectionId, eventId), '1', 'EX', 60 * 60 * 24 * 30);
}

export async function isCampaignTestEvent(connectionId: string, eventId: string): Promise<boolean> {
  if (!eventId) return false;
  return (await redis.exists(REDIS_KEYS.campaignTestEvent(connectionId, eventId))) === 1;
}

/** Small guard so a double-click cannot send the same test copy twice within a few seconds. */
export async function acquireCampaignTestCopyLock(id: string, ttlSeconds = 5): Promise<boolean> {
  const res = await redis.set(REDIS_KEYS.campaignTestCopyLock(id), '1', 'EX', ttlSeconds, 'NX');
  return res === 'OK';
}
