import IORedis from 'ioredis';
import { env } from '../config/env';

export function createRedis(): IORedis {
  const client = new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
  client.on('error', (err) => {
    if (env.NODE_ENV !== 'test') {
      // eslint-disable-next-line no-console
      console.error('[redis]', err.message);
    }
  });
  return client;
}

export const redis = createRedis();
