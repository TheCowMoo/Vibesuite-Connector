import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

export interface ListRecord {
  id: string;
  name: string;
  content: string;
  criteria: string;
  result?: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface ListSummary {
  id: string;
  name: string;
  criteria: string;
  hasResult: boolean;
  createdAt: number;
}

export async function createList(name: string, content: string, criteria: string): Promise<ListRecord> {
  const now = Date.now();
  const rec: ListRecord = { id: randomUUID(), name, content, criteria, createdAt: now, updatedAt: now };
  await redis
    .multi()
    .sadd(REDIS_KEYS.listsIndex(), rec.id)
    .set(REDIS_KEYS.list(rec.id), JSON.stringify(rec))
    .exec();
  return rec;
}

export async function listLists(): Promise<ListSummary[]> {
  const ids = await redis.smembers(REDIS_KEYS.listsIndex());
  const recs = await Promise.all(
    ids.map(async (id) => {
      const raw = await redis.get(REDIS_KEYS.list(id));
      if (!raw) return null;
      try {
        const r = JSON.parse(raw) as ListRecord;
        return { id: r.id, name: r.name, criteria: r.criteria, hasResult: r.result != null, createdAt: r.createdAt };
      } catch {
        return null;
      }
    })
  );
  return recs.filter((r): r is ListSummary => r !== null);
}

export async function getList(id: string): Promise<ListRecord | null> {
  const raw = await redis.get(REDIS_KEYS.list(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ListRecord;
  } catch {
    return null;
  }
}

export async function saveListResult(id: string, result: unknown): Promise<void> {
  const rec = await getList(id);
  if (!rec) return;
  rec.result = result;
  rec.updatedAt = Date.now();
  await redis.set(REDIS_KEYS.list(id), JSON.stringify(rec));
}

export async function deleteList(id: string): Promise<void> {
  await redis
    .multi()
    .srem(REDIS_KEYS.listsIndex(), id)
    .del(REDIS_KEYS.list(id))
    .exec();
}
