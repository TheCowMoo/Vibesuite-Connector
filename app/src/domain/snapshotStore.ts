import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function saveSnapshot(connectionId: string, payload: Record<string, unknown>): Promise<void> {
  await redis.set(REDIS_KEYS.snapshot(connectionId), JSON.stringify(payload), 'EX', TTL_SECONDS);
}

export async function getSnapshot(connectionId: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(REDIS_KEYS.snapshot(connectionId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
