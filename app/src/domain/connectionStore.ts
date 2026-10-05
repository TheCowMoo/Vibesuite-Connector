import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';
import { seal, open } from '../lib/crypto';
import type { Connection, ConnectionSecrets, StoredConnection } from './connection';

function toMeta(conn: StoredConnection): Connection {
  return {
    id: conn.id,
    name: conn.name,
    status: conn.status,
    googleCalendarId: conn.googleCalendarId,
    googleAuthType: conn.googleAuthType,
    googleServiceAccountEmail: conn.googleServiceAccountEmail,
    googleSubject: conn.googleSubject,
    ghlAuthType: conn.ghlAuthType,
    ghlLocationId: conn.ghlLocationId,
    webhookUrls: conn.webhookUrls,
    watchChannelId: conn.watchChannelId,
    watchExpiresAt: conn.watchExpiresAt,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

function toSecrets(conn: StoredConnection): ConnectionSecrets {
  return {
    googleRefreshToken: conn.googleRefreshToken,
    googleServiceAccountKey: conn.googleServiceAccountKey,
    ghlAccessToken: conn.ghlAccessToken,
    ghlRefreshToken: conn.ghlRefreshToken,
    ghlApiToken: conn.ghlApiToken,
  };
}

/** Strip secrets before exposing a connection over the API/dashboard. */
export function publicConnection(conn: StoredConnection): Connection {
  return toMeta(conn);
}

export async function saveConnection(conn: StoredConnection): Promise<void> {
  const meta = toMeta(conn);
  const secrets = toSecrets(conn);
  const encrypted = seal(JSON.stringify(secrets), env.CREDENTIALS_ENCRYPTION_KEY);
  await redis
    .multi()
    .sadd(REDIS_KEYS.connectionsIndex(), conn.id)
    .set(REDIS_KEYS.connection(conn.id), JSON.stringify(meta))
    .set(REDIS_KEYS.connectionSecrets(conn.id), encrypted)
    .exec();
}

export async function getConnection(id: string): Promise<StoredConnection | null> {
  const [metaRaw, secretsRaw] = await Promise.all([
    redis.get(REDIS_KEYS.connection(id)),
    redis.get(REDIS_KEYS.connectionSecrets(id)),
  ]);
  if (!metaRaw) return null;

  const meta = JSON.parse(metaRaw) as Connection;
  let secrets: ConnectionSecrets = {};
  if (secretsRaw) {
    try {
      secrets = JSON.parse(open(secretsRaw, env.CREDENTIALS_ENCRYPTION_KEY)) as ConnectionSecrets;
    } catch {
      secrets = {};
    }
  }
  return { ...meta, ...secrets };
}

export async function listConnections(): Promise<StoredConnection[]> {
  const ids = await redis.smembers(REDIS_KEYS.connectionsIndex());
  const conns = await Promise.all(ids.map((id) => getConnection(id)));
  return conns.filter((c): c is StoredConnection => c !== null);
}

export async function getActiveConnections(): Promise<StoredConnection[]> {
  const all = await listConnections();
  return all.filter((c) => c.status === 'active');
}

export async function deleteConnection(id: string): Promise<void> {
  await redis
    .multi()
    .srem(REDIS_KEYS.connectionsIndex(), id)
    .del(REDIS_KEYS.connection(id))
    .del(REDIS_KEYS.connectionSecrets(id))
    .exec();
}

export function newConnectionId(): string {
  return randomUUID();
}
