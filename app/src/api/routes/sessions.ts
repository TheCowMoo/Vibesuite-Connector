import type { FastifyInstance } from 'fastify';
import { createSession, getSession, listSessions, deleteSession } from '../../domain/sessionStore';
import { getAttendance } from '../../domain/attendanceStore';
import { syncSession, dispatchSession } from '../../workers/attendance';
import type { VideoProvider } from '../../video/types';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sessions', async () => {
    return { sessions: await listSessions() };
  });

  app.post('/api/sessions', async (req, reply) => {
    const b = req.body as {
      provider: VideoProvider;
      externalId: string;
      title: string;
      startTime: string;
      endTime: string;
      joinUrl?: string;
      connectionId?: string;
      inviteId?: string;
      listId?: string;
    };
    if (!b.provider || !b.externalId || !b.title || !b.startTime || !b.endTime) {
      reply.code(400).send({ error: 'provider, externalId, title, startTime and endTime are required' });
      return;
    }
    const rec = await createSession(b);
    reply.code(201).send({ session: rec });
  });

  app.get('/api/sessions/:id', async (req, reply) => {
    const session = await getSession((req.params as { id: string }).id);
    if (!session) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const attendance = await getAttendance(session.id);
    return { session, attendance };
  });

  app.get('/api/sessions/:id/snapshot', async (req, reply) => {
    const session = await getSession((req.params as { id: string }).id);
    if (!session) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    return { snapshot: session.samplePayload ?? null };
  });

  app.post('/api/sessions/:id/sync', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const report = await syncSession(id);
      return { ok: true, report };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post('/api/sessions/:id/dispatch', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const res = await dispatchSession(id);
      return { ok: true, ...res };
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.delete('/api/sessions/:id', async (req) => {
    await deleteSession((req.params as { id: string }).id);
    return { ok: true };
  });
}
