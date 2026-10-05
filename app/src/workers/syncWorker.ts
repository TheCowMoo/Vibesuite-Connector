import { Worker } from 'bullmq';
import { redis } from '../queue/connection';
import { QUEUE_NAMES } from '../config/constants';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { startMetricsServer } from '../lib/metricsServer';
import { processSync } from './pipeline';
import type { SyncJobData } from '../queue/jobs/types';
import { startWatchRenewal } from '../scheduler/renewal';

async function main(): Promise<void> {
  const worker = new Worker<SyncJobData>(
    QUEUE_NAMES.sync,
    async (job) => {
      await processSync(job.data.connectionId);
    },
    { connection: redis, concurrency: env.WORKER_CONCURRENCY }
  );

  worker.on('completed', (job) => logger.info({ jobId: job.id, connectionId: job.data.connectionId }, 'sync job completed'));
  worker.on('failed', (job, err) => {
    inc('sync_errors_total');
    logger.error({ jobId: job?.id, connectionId: job?.data?.connectionId, err: err.message }, 'sync job failed');
  });

  startWatchRenewal();

  if (env.METRICS_PORT > 0) {
    startMetricsServer(env.METRICS_PORT);
  }

  logger.info('sync worker started (multi-tenant, incl. watch renewal scheduler + metrics)');
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'worker startup failed');
  process.exit(1);
});

