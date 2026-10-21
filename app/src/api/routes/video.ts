import type { FastifyInstance } from 'fastify';
import { getVideoSettings, saveVideoSettings, publicVideoSettings } from '../../domain/videoSettings';
import { deleteZoomAccount, getZoomAccount, listZoomAccounts } from '../../domain/zoomStore';
import { listSessions } from '../../domain/sessionStore';
import { zoomOAuthConfigured } from '../../oauth/zoomOAuth';
import { defaultZoomAuthMode } from '../../video/zoomAuth';
import { forgetZoomToken, probeReportsFor, zoomProvider } from '../../video';

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

  app.get('/api/zoom/accounts', async () => {
    return { accounts: await listZoomAccounts() };
  });

  /** Disconnect one host. Campaigns that pointed at it will report "reconnect" on their next sync. */
  app.delete('/api/zoom/accounts/:userId', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    if (!(await getZoomAccount(userId))) {
      reply.code(404).send({ error: 'Zoom account not connected' });
      return;
    }

    await deleteZoomAccount(userId);
    forgetZoomToken(userId);

    return { ok: true, accounts: await listZoomAccounts() };
  });

  /**
   * Re-verify report access for a host.
   *
   * Judged by the **participants** call attendance actually uses (the old users-report probe needed a
   * scope nothing else did), which means it needs a real, finished meeting. Prefer one hosted by this
   * account; fall back to any finished Zoom session.
   */
  app.post('/api/zoom/accounts/:userId/probe', async (req, reply) => {
    const { userId } = req.params as { userId: string };
    const account = await getZoomAccount(userId);
    if (!account) {
      reply.code(404).send({ error: 'Zoom account not connected' });
      return;
    }

    const finished = (await listSessions()).filter(
      (s) => s.provider === 'zoom' && s.externalId && Date.parse(s.endTime) < Date.now(),
    );
    const candidate = finished.find((s) => s.zoomUserId === userId) ?? finished[0];

    if (!candidate) {
      return {
        ok: true,
        reportAccess: account.reportAccess ?? 'unknown',
        detail: 'Sync a finished video call to verify report access — there is no past Zoom call to ask about yet.',
      };
    }

    try {
      const result = await probeReportsFor(candidate.externalId, candidate.sessionType ?? 'meeting', {
        connectionId: candidate.connectionId,
        zoomUserId: userId,
      });

      return {
        ok: true,
        reportAccess: result.access,
        detail: result.detail,
        missingScopes: result.missingScopes ?? account.reportMissingScopes,
      };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });
}

