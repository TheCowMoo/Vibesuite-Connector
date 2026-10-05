import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { createWatchChannel } from '../google/watch';
import { getActiveConnections, saveConnection } from '../domain/connectionStore';
import { getChannel, getChannelIdByConnection, persistChannel } from '../domain/watchStore';

export async function checkAndRenew(): Promise<void> {
  const conns = await getActiveConnections();
  if (conns.length === 0) {
    logger.debug('no active connections to renew');
    return;
  }

  const thresholdMs = env.WATCH_RENEWAL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;

  for (const conn of conns) {
    try {
      const channelId = conn.watchChannelId ?? (await getChannelIdByConnection(conn.id));
      if (!channelId) {
        logger.warn({ connectionId: conn.id }, 'no watch channel; run bootstrap to create one');
        continue;
      }

      const channel = await getChannel(channelId);
      const expiresAt = conn.watchExpiresAt ?? channel?.expiresAt ?? 0;
      if (expiresAt - Date.now() > thresholdMs) {
        logger.info({ connectionId: conn.id, channelId, expiresAt: new Date(expiresAt).toISOString() }, 'watch channel still valid');
        continue;
      }

      logger.info({ connectionId: conn.id, channelId }, 'watch channel expiring soon; renewing');
      const renewed = await createWatchChannel(conn, channelId);
      await persistChannel(renewed);

      conn.watchChannelId = renewed.channelId;
      conn.watchExpiresAt = renewed.expiresAt;
      conn.updatedAt = Date.now();
      await saveConnection(conn);

      inc('watch_renewals_total');
      logger.info({ connectionId: conn.id, expiresAt: new Date(renewed.expiresAt).toISOString() }, 'watch channel renewed');
    } catch (err) {
      inc('watch_renewal_errors_total');
      logger.error({ connectionId: conn.id, err: (err as Error).message }, 'watch channel renewal failed');
    }
  }
}

export function startWatchRenewal(): NodeJS.Timeout {
  void checkAndRenew();
  return setInterval(() => {
    void checkAndRenew();
  }, env.WATCH_RENEWAL_CHECK_INTERVAL_MS);
}

