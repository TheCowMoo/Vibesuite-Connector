import type { FastifyInstance } from 'fastify';
import { getVideoSettings, saveVideoSettings, publicVideoSettings } from '../../domain/videoSettings';
import { zoomProvider } from '../../video';

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/video/settings', async () => {
    const s = await getVideoSettings();
    return { configured: !!(s.zoom || s.webinargeek), ...publicVideoSettings(s) };
  });

  app.put('/api/video/settings', async (req, reply) => {
    const b = req.body as { zoom?: { accountId?: string; clientId?: string; clientSecret?: string } };
    const existing = await getVideoSettings();

    let zoom = existing.zoom;
    if (b.zoom) {
      zoom = {
        accountId: b.zoom.accountId ?? existing.zoom?.accountId ?? '',
        clientId: b.zoom.clientId ?? existing.zoom?.clientId ?? '',
        clientSecret: b.zoom.clientSecret ? b.zoom.clientSecret : existing.zoom?.clientSecret ?? '',
      };
      if (!zoom.accountId || !zoom.clientId || !zoom.clientSecret) {
        reply.code(400).send({ error: 'Zoom accountId, clientId and clientSecret are required' });
        return;
      }
    }

    const next = { zoom, webinargeek: existing.webinargeek };
    await saveVideoSettings(next);
    return { ok: true, ...publicVideoSettings(next) };
  });

  app.post('/api/video/test', async () => {
    return zoomProvider.test();
  });
}
