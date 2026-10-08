import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

export interface InviteBatch {
  chunk: number;
  eventId: string;
  htmlLink?: string;
  count: number;
}

export interface InviteRecord {
  id: string;
  listId: string;
  listName: string;
  segments: string[];
  connectionId: string;
  connectionName: string;
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

export async function getInvitedEmails(listId: string): Promise<Set<string>> {
  const members = await redis.smembers(REDIS_KEYS.listInvited(listId));
  return new Set(members);
}

export async function markInvited(listId: string, emails: string[]): Promise<void> {
  if (!emails.length) return;
  await redis.sadd(REDIS_KEYS.listInvited(listId), ...emails);
}
