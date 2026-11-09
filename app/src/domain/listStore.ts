import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { listDataRows } from './listSegment';

export interface ListRecord {
  id: string;
  name: string;
  content: string;
  criteria: string;
  result?: unknown;
  rowCount?: number;
  charCount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ListSummary {
  id: string;
  name: string;
  criteria: string;
  hasResult: boolean;
  rowCount: number;
  createdAt: number;
  updatedAt: number;
}

function summaryFor(rec: ListRecord): ListSummary {
  return {
    id: rec.id,
    name: rec.name,
    criteria: rec.criteria,
    hasResult: rec.result != null,
    rowCount: rec.rowCount ?? listDataRows(rec.content).length,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
}

export async function createList(
  name: string,
  content: string,
  criteria: string,
  rowCount?: number,
): Promise<ListRecord> {
  const now = Date.now();
  const rec: ListRecord = {
    id: randomUUID(),
    name,
    content,
    criteria,
    rowCount: rowCount ?? listDataRows(content).length,
    charCount: content.length,
    createdAt: now,
    updatedAt: now,
  };
  await redis
    .multi()
    .sadd(REDIS_KEYS.listsIndex(), rec.id)
    .set(REDIS_KEYS.list(rec.id), JSON.stringify(rec))
    .hset(REDIS_KEYS.listsSummary(), rec.id, JSON.stringify(summaryFor(rec)))
    .exec();
  return rec;
}

function parseSummary(raw: string | undefined): ListSummary | null {
  if (!raw) return null;
  try {
    const summary = JSON.parse(raw) as ListSummary;
    if (!summary.id) return null;
    return summary;
  } catch {
    return null;
  }
}

export async function listLists(): Promise<ListSummary[]> {
  const ids = await redis.smembers(REDIS_KEYS.listsIndex());
  if (!ids.length) return [];

  const stored = await redis.hgetall(REDIS_KEYS.listsSummary());
  const byId = new Map<string, ListSummary>();
  const missing: string[] = [];
  for (const id of ids) {
    const summary = parseSummary(stored[id]);
    if (summary) byId.set(id, summary);
    else missing.push(id);
  }

  // Lists created before the summary hash existed still need one full read to backfill.
  await Promise.all(
    missing.map(async (id) => {
      const rec = await getList(id);
      if (!rec) return;
      const summary = summaryFor(rec);
      byId.set(id, summary);
      await redis.hset(REDIS_KEYS.listsSummary(), id, JSON.stringify(summary));
    }),
  );

  return ids.map((id) => byId.get(id)).filter((summary): summary is ListSummary => summary != null);
}

export async function getList(id: string): Promise<ListRecord | null> {
  const raw = await redis.get(REDIS_KEYS.list(id));
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as ListRecord;
    if (rec.rowCount == null) rec.rowCount = listDataRows(rec.content).length;
    return rec;
  } catch {
    return null;
  }
}

export async function saveListResult(id: string, result: unknown): Promise<void> {
  const rec = await getList(id);
  if (!rec) return;
  rec.result = result;
  rec.updatedAt = Date.now();
  await redis
    .multi()
    .set(REDIS_KEYS.list(id), JSON.stringify(rec))
    .hset(REDIS_KEYS.listsSummary(), id, JSON.stringify(summaryFor(rec)))
    .exec();
}

export async function deleteList(id: string): Promise<void> {
  await redis
    .multi()
    .srem(REDIS_KEYS.listsIndex(), id)
    .del(REDIS_KEYS.list(id))
    .hdel(REDIS_KEYS.listsSummary(), id)
    .exec();
}
