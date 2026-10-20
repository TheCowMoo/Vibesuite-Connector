import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { redis } from '../../queue/connection';
import { REDIS_KEYS } from '../../config/constants';
import { logger } from '../../lib/logger';
import { getConnection, saveConnection } from '../../domain/connectionStore';
import { buildGoogleAuthUrl, exchangeGoogleCode } from '../../oauth/googleOAuth';
import { buildGhlAuthUrl, exchangeGhlCode } from '../../oauth/ghlOAuth';
import {
  buildZoomAuthUrl,
  exchangeZoomCode,
  fetchZoomUser,
  probeZoomReportAccess,
  zoomErrorDetail,
} from '../../oauth/zoomOAuth';
import { expiryFrom, upsertZoomAccount } from '../../video/zoomAuth';
import { bootstrapConnection } from '../../domain/bootstrap';

const STATE_TTL_SECONDS = 600;

async function storeState(value: string): Promise<string> {
  const state = randomBytes(16).toString('hex');
  await redis.set(REDIS_KEYS.oauthState(state), value, 'EX', STATE_TTL_SECONDS);
  return state;
}

async function consumeState(state: string): Promise<string | null> {
  const connectionId = await redis.get(REDIS_KEYS.oauthState(state));
  if (connectionId) await redis.del(REDIS_KEYS.oauthState(state));
  return connectionId;
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  // --- Google OAuth ---
  app.get('/oauth/google/start', async (req, reply) => {
    const connectionId = (req.query as { connectionId?: string }).connectionId;
    if (!connectionId) {
      reply.code(400).send({ error: 'connectionId is required' });
      return;
    }
    const state = await storeState(connectionId);
    return reply.redirect(buildGoogleAuthUrl(state));
  });

  app.get('/oauth/google/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) {
      reply.code(400).send({ error: 'missing code or state' });
      return;
    }
    const connectionId = await consumeState(state);
    if (!connectionId) {
      reply.code(400).send({ error: 'invalid or expired state' });
      return;
    }
    const conn = await getConnection(connectionId);
    if (!conn) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }

    try {
      const tokens = await exchangeGoogleCode(code);
      if (!tokens.refresh_token) {
        reply.code(400).send({ error: 'no refresh token returned; re-authorize with prompt=consent' });
        return;
      }
      conn.googleAuthType = 'oauth';
      conn.googleRefreshToken = tokens.refresh_token;
      conn.updatedAt = Date.now();
      await saveConnection(conn);

      try {
        await bootstrapConnection(connectionId);
      } catch (err) {
        logger.error({ connectionId, err: (err as Error).message }, 'bootstrap after Google OAuth failed');
      }
      return reply.redirect('/');
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  // --- GHL OAuth ---
  app.get('/oauth/ghl/start', async (req, reply) => {
    const connectionId = (req.query as { connectionId?: string }).connectionId;
    if (!connectionId) {
      reply.code(400).send({ error: 'connectionId is required' });
      return;
    }
    const state = await storeState(connectionId);
    return reply.redirect(buildGhlAuthUrl(state));
  });

  app.get('/oauth/ghl/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) {
      reply.code(400).send({ error: 'missing code or state' });
      return;
    }
    const connectionId = await consumeState(state);
    if (!connectionId) {
      reply.code(400).send({ error: 'invalid or expired state' });
      return;
    }
    const conn = await getConnection(connectionId);
    if (!conn) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }

    try {
      const tokens = await exchangeGhlCode(code);
      conn.ghlAuthType = 'oauth';
      conn.ghlAccessToken = tokens.access_token;
      if (tokens.refresh_token) conn.ghlRefreshToken = tokens.refresh_token;
      if (tokens.locationId) conn.ghlLocationId = tokens.locationId;
      conn.updatedAt = Date.now();
      await saveConnection(conn);
      return reply.redirect('/');
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  // --- Zoom user OAuth (user-managed General App) ---
  // Each connection holds its own authorised Zoom hosts, so the state is namespaced with `zoom:`.
  // Without the prefix a Google state could be replayed at this callback.
  app.get('/oauth/zoom/start', async (req, reply) => {
    const connectionId = (req.query as { connectionId?: string }).connectionId;
    if (!connectionId) {
      reply.code(400).send({ error: 'connectionId is required' });
      return;
    }
    if (!(await getConnection(connectionId))) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }

    const state = await storeState(`zoom:${connectionId}`);
    try {
      return reply.redirect(buildZoomAuthUrl(state));
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.get('/oauth/zoom/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) {
      reply.code(400).send({ error: 'missing code or state' });
      return;
    }

    const stored = await consumeState(state);
    if (!stored || !stored.startsWith('zoom:')) {
      reply.code(400).send({ error: 'invalid or expired state' });
      return;
    }

    const conn = await getConnection(stored.slice('zoom:'.length));
    if (!conn) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }

    try {
      const tokens = await exchangeZoomCode(code);
      if (!tokens.refresh_token) {
        reply.code(400).send({
          error: 'Zoom did not return a refresh token — remove the app from Zoom and connect again',
        });
        return;
      }

      const user = await fetchZoomUser(tokens.access_token);
      // Ask once, up front: a non-admin host is refused report access, and the UI needs to know now
      // rather than showing empty polls later.
      const reportAccess = await probeZoomReportAccess(tokens.access_token, user.id);

      conn.zoomTokens = {
        ...(conn.zoomTokens ?? {}),
        [user.id]: {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token,
          expiresAt: expiryFrom(Date.now(), tokens.expires_in),
        },
      };
      conn.zoomAccounts = upsertZoomAccount(conn.zoomAccounts, {
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        connectedAt: Date.now(),
        reportAccess,
      });
      conn.updatedAt = Date.now();
      await saveConnection(conn);

      return reply.redirect('/');
    } catch (err) {
      reply.code(500).send({ error: zoomErrorDetail(err) });
    }
  });
}
