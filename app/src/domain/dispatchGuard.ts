import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';

// Long enough to absorb BullMQ retries after a partially-completed dispatch,
// short enough that genuine rapid status toggles are not suppressed.
const DISPATCH_TTL_SECONDS = 300;

export async function tryClaimDispatch(connectionId: string, fingerprint: string): Promise<boolean> {
  const res = await redis.set(REDIS_KEYS.dispatched(connectionId, fingerprint), '1', 'EX', DISPATCH_TTL_SECONDS, 'NX');
  return res === 'OK';
}

export async function releaseDispatch(connectionId: string, fingerprint: string): Promise<void> {
  await redis.del(REDIS_KEYS.dispatched(connectionId, fingerprint));
}

