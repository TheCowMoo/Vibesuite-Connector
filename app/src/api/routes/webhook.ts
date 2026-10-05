import type { FastifyInstance, FastifyRequest } from 'fastify';
import { syncQueue } from '../../queue/queues';
import { JOB_NAMES } from '../../config/constants';
import { getChannel } from '../../domain/watchStore';
import { verifyGoogleWebhook } from '../middleware/verifyGoogle';
import { inc } from '../../lib/metrics';
import { logger } from '../../lib/logger';
import type { SyncJobData } from '../../queue/jobs/types';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/webhooks/google/calendar',
    {
      onRequest: async (req: FastifyRequest) => {
        const resourceState = (req.headers['x-goog-resource-state'] ?? 'unknown') as string;
        inc('webhook_received_total', { resource_state: resourceState });
      },
      preHandler: verifyGoogleWebhook,
    },
    async (req, reply) => {
      const channelId = (req.headers['x-goog-channel-id'] ?? '') as string;
      const resourceId = (req.headers['x-goog-resource-id'] ?? '') as string;
      const resourceUri = (req.headers['x-goog-resource-uri'] ?? '') as string;
      const resourceState = (req.headers['x-goog-resource-state'] ?? 'exists') as SyncJobData['resourceState'];
      const messageNumber = (req.headers['x-goog-message-number'] ?? '') as string;

      const channel = await getChannel(channelId);
      const connectionId = channel?.connectionId;

      if (!connectionId) {
        reply.code(400).send({ error: 'channel not mapped to a connection' });
        return;
      }

      // "sync" is Google's confirmation that the channel was created; nothing to fetch yet.
      if (resourceState === 'sync') {
        logger.info({ channelId, connectionId, resourceId }, 'received sync notification');
        reply.code(200).send({ ok: true });
        return;
      }

      const jobData: SyncJobData = {
        connectionId,
        resourceId,
        resourceUri,
        resourceState,
        messageNumber: messageNumber || undefined,
        receivedAt: Date.now(),
      };

      // Respond 200 immediately to satisfy Google's webhook reliability window, then enqueue.
      reply.code(200).send({ ok: true });

      syncQueue
        .add(JOB_NAMES.processSync, jobData)
        .then(() => inc('jobs_enqueued_total'))
        .catch((err) => {
          inc('jobs_enqueue_failed_total');
          logger.error({ err: (err as Error).message, connectionId }, 'failed to enqueue sync job');
        });
    }
  );
}


