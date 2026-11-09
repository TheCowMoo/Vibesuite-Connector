import { Worker } from 'bullmq';
import { redis } from '../queue/connection';
import { QUEUE_NAMES } from '../config/constants';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { startMetricsServer } from '../lib/metricsServer';
import { processSync } from './pipeline';
import { processListSegmentation } from './listSegment';
import type { ListSegmentJobData, SyncJobData } from '../queue/jobs/types';
import { startWatchRenewal } from '../scheduler/renewal';
import { startAttendancePolling } from '../scheduler/attendance';
import { startCampaignScheduler } from '../scheduler/campaigns';
import { startInviteScheduler } from '../scheduler/invites';
import { startReconciliation } from '../scheduler/reconcile';

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

  const listSegmentWorker = new Worker<ListSegmentJobData>(
    QUEUE_NAMES.listSegment,
    async (job) => {
      await processListSegmentation(job.data.listId, job.data.runId);
    },
    {
      connection: redis,
      concurrency: env.LIST_SEGMENT_JOB_CONCURRENCY,
      // A 500-row AI batch can take longer than BullMQ's default 30s lock.
      lockDuration: 120000,
    }
  );
  listSegmentWorker.on('completed', (job) =>
    logger.info({ jobId: job.id, listId: job.data.listId }, 'list segmentation completed')
  );
  listSegmentWorker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, listId: job?.data?.listId, err: err.message }, 'list segmentation job failed')
  );

  startWatchRenewal();
  startAttendancePolling();
  startCampaignScheduler();
  startInviteScheduler();
  startReconciliation();

  if (env.METRICS_PORT > 0) {
    startMetricsServer(env.METRICS_PORT);
  }

  logger.info('sync worker started (multi-tenant, incl. watch renewal + reconcile + metrics)');
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, 'worker startup failed');
  process.exit(1);
});

