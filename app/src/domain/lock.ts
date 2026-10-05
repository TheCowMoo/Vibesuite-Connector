import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

export async function acquireLock(connectionId: string, ttlSeconds: number): Promise<boolean> {
  const result = await redis.set(REDIS_KEYS.lock(connectionId), '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

export async function releaseLock(connectionId: string): Promise<void> {
  await redis.del(REDIS_KEYS.lock(connectionId));
}

