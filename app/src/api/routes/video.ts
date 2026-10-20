import type { FastifyInstance } from 'fastify';
import { getConnection, publicConnection, saveConnection } from '../../domain/connectionStore';
import { getVideoSettings, saveVideoSettings, publicVideoSettings } from '../../domain/videoSettings';
import { probeZoomReportAccess, zoomOAuthConfigured } from '../../oauth/zoomOAuth';
import { removeZoomAccount, withoutZoomToken } from '../../video/zoomAuth';
import { defaultZoomAuthMode } from '../../video/zoomAuth';
import { zoomAccessToken, zoomProvider } from '../../video';

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/video/settings', async () => {
    const s = await getVideoSettings();
    return {
      configured: !!(s.zoom || s.webinargeek),
      ...publicVideoSettings(s),
      // Lets the UI hide "Connect Zoom" until there is actually an app to connect to.
      zoomUserOAuthConfigured: zoomOAuthConfigured(),
    };
  });

  app.put('/api/video/settings', async (req, reply) => {
    const b = req.body as {
      zoomAuthMode?: 's2s' | 'user';
      zoom?: { accountId?: string; clientId?: string; clientSecret?: string };
    };
    if (b.zoomAuthMode !== undefined && b.zoomAuthMode !== 's2s' && b.zoomAuthMode !== 'user') {
      reply.code(400).send({ error: 'zoomAuthMode must be "s2s" or "user"' });
      return;
    }

    const existing = await getVideoSettings();
    const mode = b.zoomAuthMode ?? defaultZoomAuthMode(existing.zoomAuthMode);

    let zoom = existing.zoom;
    if (b.zoom) {
      zoom = {
        accountId: b.zoom.accountId ?? existing.zoom?.accountId ?? '',
        clientId: b.zoom.clientId ?? existing.zoom?.clientId ?? '',
        clientSecret: b.zoom.clientSecret ? b.zoom.clientSecret : existing.zoom?.clientSecret ?? '',
      };
    }

    // Picking server-to-server without credentials would save a mode that cannot authenticate, so
    // reject it even when this request did not send a `zoom` block.
    if (mode === 's2s' && (!zoom?.accountId || !zoom.clientId || !zoom.clientSecret)) {
      reply.code(400).send({ error: 'server-to-server needs Zoom accountId, clientId and clientSecret' });
      return;
    }

    const next = { zoomAuthMode: mode, zoom, webinargeek: existing.webinargeek };
    await saveVideoSettings(next);
    return { ok: true, ...publicVideoSettings(next) };
  });

  /** Test whichever identity the request names — a connected host, or the account-wide app. */
  app.post('/api/video/test', async (req) => {
    const b = (req.body || {}) as { connectionId?: string; zoomUserId?: string };
    return zoomProvider.test({ connectionId: b.connectionId, zoomUserId: b.zoomUserId });
  });

  /** Disconnect one authorised Zoom host, leaving the connection's other hosts untouched. */
  app.delete('/api/connections/:id/zoom/accounts/:userId', async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const conn = await getConnection(id);
    if (!conn) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }

    conn.zoomAccounts = removeZoomAccount(conn.zoomAccounts, userId);
    conn.zoomTokens = withoutZoomToken(conn.zoomTokens, userId);
    conn.updatedAt = Date.now();
    await saveConnection(conn);

    return { ok: true, connection: publicConnection(conn) };
  });

  /**
   * Re-ask Zoom whether this host may read reports.
   *
   * Worth its own route because the answer changes outside the app: an account admin approving the
   * app or granting the report scope turns a previously-refused host into a working one, and the
   * operator should not have to disconnect and reconnect to pick that up.
   */
  app.post('/api/connections/:id/zoom/accounts/:userId/probe', async (req, reply) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const conn = await getConnection(id);
    const account = conn?.zoomAccounts?.find((a) => a.userId === userId);
    if (!conn || !account) {
      reply.code(404).send({ error: 'Zoom account not connected for this connection' });
      return;
    }

    try {
      const token = await zoomAccessToken({ connectionId: id, zoomUserId: userId });
      account.reportAccess = await probeZoomReportAccess(token, userId);
      conn.updatedAt = Date.now();
      await saveConnection(conn);

      return { ok: true, reportAccess: account.reportAccess, connection: publicConnection(conn) };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });
}

