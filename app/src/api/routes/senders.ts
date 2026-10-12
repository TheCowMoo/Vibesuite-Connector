import type { FastifyInstance } from 'fastify';
import { getConnection, listConnections } from '../../domain/connectionStore';
import {
  clearSenderCooldown,
  getSenderGauge,
  getSenderProfile,
  parseSenderProfile,
  saveSenderProfile,
} from '../../domain/senderStore';
import { requireRole } from '../middleware/requireAuth';
import { runSenderNow } from '../../scheduler/campaigns';

async function senderView(connectionId: string, name: string, calendarId: string): Promise<Record<string, unknown>> {
  const gauge = await getSenderGauge(connectionId);
  return {
    connectionId,
    name,
    calendarId,
    profile: gauge.profile,
    state: gauge.state,
    today: {
      capToday: gauge.capToday,
      sentToday: gauge.sentToday,
      failedToday: gauge.failedToday,
      sentThisHour: gauge.sentThisHour,
      headroom: gauge.headroom,
      rampDayIndex: gauge.rampDayIndex,
      inWindow: gauge.inWindow,
      cooling: gauge.cooling,
    },
  };
}

export async function senderRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requireRole('owner', 'admin') };

  app.get('/api/senders', guard, async () => {
    const conns = await listConnections();
    const senders = await Promise.all(conns.map((c) => senderView(c.id, c.name, c.googleCalendarId)));
    return { senders };
  });

  app.get('/api/senders/:connectionId', guard, async (req, reply) => {
    const conn = await getConnection((req.params as { connectionId: string }).connectionId);
    if (!conn) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }
    return { sender: await senderView(conn.id, conn.name, conn.googleCalendarId) };
  });

  app.patch('/api/senders/:connectionId', guard, async (req, reply) => {
    const connectionId = (req.params as { connectionId: string }).connectionId;
    const conn = await getConnection(connectionId);
    if (!conn) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }

    const current = await getSenderProfile(connectionId);
    const parsed = parseSenderProfile({ ...current, ...(req.body as Record<string, unknown>) }, connectionId);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid sender settings', details: parsed.error.flatten().fieldErrors });
      return;
    }

    await saveSenderProfile(parsed.data);
    return { ok: true, sender: await senderView(conn.id, conn.name, conn.googleCalendarId) };
  });

  app.post('/api/senders/:connectionId/pause', guard, async (req, reply) => {
    const connectionId = (req.params as { connectionId: string }).connectionId;
    if (!(await getConnection(connectionId))) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }
    const profile = await getSenderProfile(connectionId);
    profile.enabled = false;
    await saveSenderProfile(profile);
    return { ok: true };
  });

  app.post('/api/senders/:connectionId/resume', guard, async (req, reply) => {
    const connectionId = (req.params as { connectionId: string }).connectionId;
    if (!(await getConnection(connectionId))) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }
    const profile = await getSenderProfile(connectionId);
    profile.enabled = true;
    await saveSenderProfile(profile);
    await clearSenderCooldown(connectionId);
    return { ok: true };
  });

  /**
   * Operator override: run a batch for this mailbox right now. Daily/hourly caps,
   * the send window and cooldowns still apply — only the inter-batch pacing is skipped.
   */
  app.post('/api/senders/:connectionId/send-now', guard, async (req, reply) => {
    const connectionId = (req.params as { connectionId: string }).connectionId;
    if (!(await getConnection(connectionId))) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }

    const body = (req.body || {}) as { maxPerSender?: number };
    const requested = Number(body.maxPerSender ?? 200);
    const maxPerSender = Math.min(1000, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 200));

    try {
      return { ok: true, ...(await runSenderNow(connectionId, maxPerSender)) };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
  });
}
