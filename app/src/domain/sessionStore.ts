import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { VideoProvider } from '../video/types';

export type SessionStatus = 'pending' | 'synced' | 'failed';

export interface SessionRecord {
  id: string;
  provider: VideoProvider;
  externalId: string;
  joinUrl?: string;
  title: string;
  connectionId?: string;
  inviteId?: string;
  listId?: string;
  startTime: string;
  endTime: string;
  status: SessionStatus;
  lastSyncedAt?: number;
  error?: string;
  samplePayload?: unknown;
  createdAt: number;
}

export async function createSession(input: Omit<SessionRecord, 'id' | 'status' | 'createdAt'>): Promise<SessionRecord> {
  const rec: SessionRecord = { ...input, id: randomUUID(), status: 'pending', createdAt: Date.now() };
  await redis
    .multi()
    .sadd(REDIS_KEYS.sessionsIndex(), rec.id)
    .set(REDIS_KEYS.session(rec.id), JSON.stringify(rec))
    .exec();
  return rec;
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  const raw = await redis.get(REDIS_KEYS.session(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

export async function saveSession(rec: SessionRecord): Promise<void> {
  await redis.set(REDIS_KEYS.session(rec.id), JSON.stringify(rec));
}

export async function listSessions(): Promise<SessionRecord[]> {
  const ids = await redis.smembers(REDIS_KEYS.sessionsIndex());
  const recs = await Promise.all(
    ids.map(async (id) => {
      const raw = await redis.get(REDIS_KEYS.session(id));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SessionRecord;
      } catch {
        return null;
      }
    })
  );
  return recs.filter((r): r is SessionRecord => r !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSession(id: string): Promise<void> {
  await redis
    .multi()
    .srem(REDIS_KEYS.sessionsIndex(), id)
    .del(REDIS_KEYS.session(id))
    .del(REDIS_KEYS.attendance(id))
    .exec();
}
