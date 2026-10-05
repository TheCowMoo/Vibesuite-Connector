import type { FastifyRequest } from 'fastify';
import { getChannel } from '../../domain/watchStore';
import { inc } from '../../lib/metrics';
import { HttpError } from './errorHandler';

export async function verifyGoogleWebhook(req: FastifyRequest): Promise<void> {
  const channelId = req.headers['x-goog-channel-id'] as string | undefined;
  const token = req.headers['x-goog-channel-token'] as string | undefined;
  const resourceId = req.headers['x-goog-resource-id'] as string | undefined;
  const resourceState = req.headers['x-goog-resource-state'] as string | undefined;

  if (!channelId || !resourceId || !resourceState) {
    inc('webhook_rejected_total', { reason: 'missing_headers' });
    throw new HttpError(400, 'missing required X-Goog headers');
  }

  const channel = await getChannel(channelId);
  if (!channel) {
    inc('webhook_rejected_total', { reason: 'unknown_channel' });
    throw new HttpError(403, 'unknown channel');
  }

  if (channel.token && channel.token !== token) {
    inc('webhook_rejected_total', { reason: 'invalid_token' });
    throw new HttpError(403, 'invalid channel token');
  }

  if (channel.resourceId && channel.resourceId !== resourceId) {
    inc('webhook_rejected_total', { reason: 'resource_mismatch' });
    throw new HttpError(403, 'resource id mismatch');
  }
}
