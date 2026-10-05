import { logger } from '../lib/logger';
import { fullSync } from '../google/sync';
import { createWatchChannel } from '../google/watch';
import { stateStore } from './stateStore';
import { persistChannel } from './watchStore';
import { getConnection, saveConnection } from './connectionStore';

/**
 * Perform an initial full sync (baseline) and create the watch channel for a
 * connection, then mark it active. Used by the CLI bootstrap and OAuth callback.
 */
export async function bootstrapConnection(connectionId: string): Promise<void> {
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error(`connection ${connectionId} not found`);

  const { items, nextSyncToken } = await fullSync(conn);
  await stateStore.saveStates(connectionId, items.filter((e) => e.status !== 'cancelled'));
  await stateStore.saveSyncToken(connectionId, nextSyncToken);

  const channel = await createWatchChannel(conn);
  await persistChannel(channel);

  conn.watchChannelId = channel.channelId;
  conn.watchExpiresAt = channel.expiresAt;
  conn.status = 'active';
  conn.updatedAt = Date.now();
  await saveConnection(conn);

  logger.info({ connectionId, count: items.length, channelId: channel.channelId }, 'connection bootstrapped');
}
