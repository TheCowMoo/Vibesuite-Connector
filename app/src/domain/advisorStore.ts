import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { AdvisorAnalysis, ApplyLogEntry } from './advisorTypes';

export async function saveAnalysis(analysis: AdvisorAnalysis): Promise<void> {
  await redis.set(REDIS_KEYS.advisorAnalysis(), JSON.stringify(analysis));
}

export async function getAnalysis(): Promise<AdvisorAnalysis | null> {
  const raw = await redis.get(REDIS_KEYS.advisorAnalysis());
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdvisorAnalysis;
  } catch {
    return null;
  }
}

/** Append-only audit trail of every Apply, capped at 200 entries. */
export async function appendApplyLog(entry: ApplyLogEntry): Promise<void> {
  const key = REDIS_KEYS.advisorApplyLog();
  await redis.multi().lpush(key, JSON.stringify(entry)).ltrim(key, 0, 199).exec();
}

export async function getApplyLog(limit = 50): Promise<ApplyLogEntry[]> {
  const raw = await redis.lrange(REDIS_KEYS.advisorApplyLog(), 0, Math.max(0, limit - 1));
  return raw
    .map((r) => {
      try {
        return JSON.parse(r) as ApplyLogEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is ApplyLogEntry => e !== null);
}
