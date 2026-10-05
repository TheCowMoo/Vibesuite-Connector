import { Queue } from 'bullmq';
import { redis } from './connection';
import { QUEUE_NAMES } from '../config/constants';
import { env } from '../config/env';

export const syncQueue = new Queue(QUEUE_NAMES.sync, {
  connection: redis,
  defaultJobOptions: {
    attempts: env.SYNC_RETRY_ATTEMPTS,
    backoff: { type: 'exponential', delay: env.SYNC_BACKOFF_DELAY_MS },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});
