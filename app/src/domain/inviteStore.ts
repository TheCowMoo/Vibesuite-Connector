import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

export interface InviteBatch {
  chunk: number;
  eventId: string;
  htmlLink?: string;
  count: number;
}

export interface InviteSenderSummary {
  connectionId: string;
  connectionName: string;
  sent: number;
  failed: number;
  /** Set when this account was picked but could not send (paused, cooling, no headroom, ...). */
  skippedReason?: string;
}

export interface InviteRecord {
  id: string;
  listId: string;
  listName: string;
  segments: string[];
  /** The account that sent the most, kept for older records and single-account sends. */
  connectionId: string;
  connectionName: string;
  /** Per-account breakdown. Absent on records written before multi-account sends existed. */
  senders?: InviteSenderSummary[];
  summary: string;
  start: string;
  end: string;
  timeZone?: string;
  recipientCount: number;
  batches: InviteBatch[];
  status: 'sent' | 'partial' | 'failed';
  error?: string;
  createdAt: number;
}

export async function createInviteRecord(input: Omit<InviteRecord, 'id' | 'createdAt'>): Promise<InviteRecord> {
  const rec: InviteRecord = { ...input, id: randomUUID(), createdAt: Date.now() };
  await redis
    .multi()
    .sadd(REDIS_KEYS.invitesIndex(), rec.id)
    .set(REDIS_KEYS.invite(rec.id), JSON.stringify(rec))
    .sadd(REDIS_KEYS.listInvites(rec.listId), rec.id)
    .exec();
  return rec;
}

export async function getInvite(id: string): Promise<InviteRecord | null> {
  const raw = await redis.get(REDIS_KEYS.invite(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as InviteRecord;
  } catch {
    return null;
  }
}

export async function listInvites(): Promise<InviteRecord[]> {
  const ids = await redis.smembers(REDIS_KEYS.invitesIndex());
  const recs = await Promise.all(
    ids.map(async (id) => {
      const raw = await redis.get(REDIS_KEYS.invite(id));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as InviteRecord;
      } catch {
        return null;
      }
    })
  );
  return recs.filter((r): r is InviteRecord => r !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteInvite(id: string): Promise<void> {
  const rec = await getInvite(id);
  await redis.multi().srem(REDIS_KEYS.invitesIndex(), id).del(REDIS_KEYS.invite(id)).exec();
  if (rec) await redis.srem(REDIS_KEYS.listInvites(rec.listId), id);
}

/**
 * What we know about one person's last invitation: which event, and when we sent it. Written
 * alongside the membership set so the UI can say "previously invited to <event>" instead of only
 * showing a count. The most recent invite wins, because that is the one you would act on when
 * deciding whether to re-invite someone.
 */
export interface InvitedMeta {
  summary: string;
  start?: string;
  at: number;
  source: 'invite' | 'campaign';
  inviteId?: string;
}

export async function getInvitedEmails(listId: string): Promise<Set<string>> {
  const members = await redis.smembers(REDIS_KEYS.listInvited(listId));
  return new Set(members);
}

export async function getInvitedMeta(listId: string): Promise<Record<string, InvitedMeta>> {
  const raw = await redis.hgetall(REDIS_KEYS.listInvitedMeta(listId));
  const out: Record<string, InvitedMeta> = {};
  if (!raw) return out;

  for (const [email, value] of Object.entries(raw)) {
    try {
      out[email] = JSON.parse(value) as InvitedMeta;
    } catch {
      // One unreadable row must not break the whole preview — it just loses its label.
    }
  }
  return out;
}

/**
 * Record that these people have been invited. `meta` is optional so existing callers keep working,
 * but both send paths pass it now — without it there is no way to name the event afterwards.
 */
export async function markInvited(
  listId: string,
  emails: string[],
  meta?: Omit<InvitedMeta, 'at'>,
): Promise<void> {
  if (!emails.length) return;

  const multi = redis.multi().sadd(REDIS_KEYS.listInvited(listId), ...emails);

  if (meta) {
    const key = REDIS_KEYS.listInvitedMeta(listId);
    const payload = JSON.stringify({ ...meta, at: Date.now() });
    for (const email of emails) multi.hset(key, email, payload);
  }

  await multi.exec();
}
