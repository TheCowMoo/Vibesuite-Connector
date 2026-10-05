import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { withRetry, isRetryableError } from '../lib/backoff';
import { refreshGhlToken } from '../oauth/ghlOAuth';
import type { StoredConnection } from '../domain/connection';

export const ghlHttp: AxiosInstance = axios.create({
  baseURL: env.GHL_BASE_URL,
  timeout: 15000,
  headers: { 'Content-Type': 'application/json' },
});

const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function resolveGhlToken(conn: StoredConnection): Promise<string> {
  if (conn.ghlAuthType === 'api_token') {
    if (!conn.ghlApiToken) throw new Error(`connection ${conn.id}: missing GHL API token`);
    return conn.ghlApiToken;
  }

  const cached = accessTokenCache.get(conn.id);
  if (cached && cached.expiresAt > Date.now() + 30000) return cached.token;

  if (!conn.ghlRefreshToken) throw new Error(`connection ${conn.id}: missing GHL refresh token`);
  const tokens = await refreshGhlToken(conn.ghlRefreshToken);
  accessTokenCache.set(conn.id, {
    token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  });
  return tokens.access_token;
}

export async function ghlRequest<T>(
  conn: StoredConnection,
  config: AxiosRequestConfig,
  opts: { idempotencyKey?: string } = {}
): Promise<T> {
  return withRetry(
    async () => {
      let token = await resolveGhlToken(conn);

      const send = (tok: string) => {
        const headers: Record<string, string> = {
          ...(config.headers as Record<string, string> | undefined),
        };
        if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
        return ghlHttp.request<T>({
          ...config,
          headers: { ...headers, Authorization: `Bearer ${tok}`, Version: env.GHL_VERSION },
        });
      };

      try {
        const res = await send(token);
        return res.data;
      } catch (err) {
        if ((err as { response?: { status?: number } })?.response?.status === 401 && conn.ghlAuthType === 'oauth') {
          accessTokenCache.delete(conn.id);
          token = await resolveGhlToken(conn);
          const res = await send(token);
          return res.data;
        }
        throw err;
      }
    },
    {
      retries: 4,
      baseDelayMs: 500,
      maxDelayMs: 30000,
      shouldRetryOn: (err) => {
        if (!isRetryableError(err)) return false;
        const status = (err as { response?: { status?: number } }).response?.status;
        if (status === 429) logger.warn({ url: config.url, connectionId: conn.id }, 'GHL rate limited (429); retrying with backoff');
        return true;
      },
      getRetryDelayMs: (err) => {
        const ra = (err as { response?: { headers?: Record<string, string> } }).response?.headers?.['retry-after'];
        const seconds = Number(ra);
        return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
      },
    }
  );
}

