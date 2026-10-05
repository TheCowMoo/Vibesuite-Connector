import { randomUUID, randomBytes } from 'node:crypto';
import { createCalendarClient } from './auth';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import type { StoredConnection } from '../domain/connection';

export interface WatchChannel {
  connectionId: string;
  calendarId: string;
  channelId: string;
  resourceId: string;
  resourceUri: string;
  token: string;
  expiresAt: number; // epoch ms
}

export async function createWatchChannel(conn: StoredConnection, channelId: string = randomUUID()): Promise<WatchChannel> {
  const calendar = createCalendarClient(conn);
  const token = randomBytes(24).toString('hex');

  const res = await calendar.events.watch({
    calendarId: conn.googleCalendarId,
    requestBody: {
      id: channelId,
      type: 'web_hook',
      address: env.GOOGLE_WEBHOOK_URL,
      token,
      params: { ttl: String(env.WATCH_TTL_SECONDS) },
    },
  });

  const data = res.data;
  const expiresAt = data.expiration ? Number(data.expiration) : Date.now() + env.WATCH_TTL_SECONDS * 1000;

  logger.info({ connectionId: conn.id, calendarId: conn.googleCalendarId, channelId, resourceId: data.resourceId }, 'watch channel created');

  return {
    connectionId: conn.id,
    calendarId: conn.googleCalendarId,
    channelId,
    resourceId: data.resourceId ?? '',
    resourceUri: data.resourceUri ?? '',
    token,
    expiresAt,
  };
}

