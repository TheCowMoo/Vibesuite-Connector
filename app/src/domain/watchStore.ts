import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { WatchChannel } from '../google/watch';

export async function persistChannel(channel: WatchChannel): Promise<void> {
  await redis.set(REDIS_KEYS.watchByChannel(channel.channelId), JSON.stringify(channel));
  await redis.set(REDIS_KEYS.watchByConnection(channel.connectionId), channel.channelId);
}

export async function getChannel(channelId: string): Promise<WatchChannel | null> {
  const raw = await redis.get(REDIS_KEYS.watchByChannel(channelId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WatchChannel;
  } catch {
    return null;
  }
}

export async function getChannelIdByConnection(connectionId: string): Promise<string | null> {
  return redis.get(REDIS_KEYS.watchByConnection(connectionId));
}

