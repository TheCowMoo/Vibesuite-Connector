import type { FastifyInstance } from 'fastify';
import {
  CampaignSchema,
  planSchedule,
  type Campaign,
} from '../../domain/campaign';
import {
  countRecipients,
  createCampaign,
  deleteCampaign,
  getCampaign,
  getCampaignSender,
  getRecipients,
  listCampaigns,
  queueLength,
  saveCampaign,
} from '../../domain/campaignStore';
import { sendCampaignBatch, startCampaign } from '../../domain/campaignDispatch';
import { getSenderProfile } from '../../domain/senderStore';
import { requireRole } from '../middleware/requireAuth';

async function withStats(camp: Campaign): Promise<Record<string, unknown>> {
  const [counts, queues, counters] = await Promise.all([
    countRecipients(camp.id),
    Promise.all(camp.senders.map((s) => queueLength(camp.id, s.connectionId))),
    Promise.all(camp.senders.map((s) => getCampaignSender(camp.id, s.connectionId))),
  ]);

  const perSender = camp.senders.map((s, i) => ({
    connectionId: s.connectionId,
    enabled: s.enabled,
    quota: s.quota,
    share: s.share,
    priority: s.priority,
    queued: queues[i],
    sent: counters[i].sent,
    failed: counters[i].failed,
  }));

  return { ...camp, counts, perSender };
}

async function refreshed(id: string): Promise<Record<string, unknown> | null> {
  const camp = await getCampaign(id);
  return camp ? withStats(camp) : null;
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function campaignRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requireRole('owner', 'admin') };

  app.get('/api/campaigns', async () => {
    const camps = await listCampaigns();
    return { campaigns: await Promise.all(camps.map(withStats)) };
  });

  app.get('/api/campaigns/:id', async (req, reply) => {
    const camp = await getCampaign((req.params as { id: string }).id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    return { campaign: await withStats(camp) };
  });

  app.get('/api/campaigns/:id/recipients', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await getCampaign(id))) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }

    const q = req.query as { status?: string; connectionId?: string; limit?: string; offset?: string };
    let recs = await getRecipients(id);
    if (q.status) recs = recs.filter((r) => r.status === q.status);
    if (q.connectionId) recs = recs.filter((r) => r.connectionId === q.connectionId);

    const total = recs.length;
    const offset = Math.max(0, Number(q.offset ?? 0) || 0);
    const limit = Math.min(500, Math.max(1, Number(q.limit ?? 100) || 100));
    return { total, offset, recipients: recs.slice(offset, offset + limit) };
  });

  /** Capacity estimate: how long the frozen audience takes across the chosen senders. */
  app.get('/api/campaigns/:id/plan', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }

    const q = req.query as { total?: string; startDate?: string };
    const counts = await countRecipients(id);
    const total = counts.total > 0 ? counts.total : Math.max(0, Number(q.total ?? 0) || 0);
    const startDate = q.startDate && /^\d{4}-\d{2}-\d{2}$/.test(q.startDate) ? q.startDate : todayISO();

    const senders = await Promise.all(
      camp.senders
        .filter((s) => s.enabled)
        .map(async (s) => ({ connectionId: s.connectionId, profile: await getSenderProfile(s.connectionId) })),
    );

    const plan = planSchedule({ total, senders, startDate });
    return {
      total,
      startDate,
      dailyCapacity: plan.days.length ? plan.days[0].total : 0,
      ...plan,
      spread: camp.distribution.mode,
    };
  });

  app.post('/api/campaigns', guard, async (req, reply) => {
    const schema = CampaignSchema.omit({ id: true, createdAt: true });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid campaign', details: parsed.error.flatten().fieldErrors });
      return;
    }
    const camp = await createCampaign(parsed.data);
    return { ok: true, campaign: await withStats(camp) };
  });

  app.patch('/api/campaigns/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    if (camp.status === 'active') {
      reply.code(400).send({ error: 'pause the campaign before editing it' });
      return;
    }

    const merged = { ...camp, ...(req.body as Record<string, unknown>), id: camp.id, createdAt: camp.createdAt };
    const parsed = CampaignSchema.safeParse(merged);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid campaign', details: parsed.error.flatten().fieldErrors });
      return;
    }
    await saveCampaign(parsed.data);
    return { ok: true, campaign: await withStats(parsed.data) };
  });

  app.delete('/api/campaigns/:id', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await getCampaign(id))) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    await deleteCampaign(id);
    return { ok: true };
  });

  /** Freeze the audience and partition it across the chosen mailboxes. */
  app.post('/api/campaigns/:id/start', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const res = await startCampaign(id);
      return { ok: true, ...res, campaign: await refreshed(id) };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
  });

  /** Send one batch right now, respecting every mailbox cap/window/cooldown. */
  app.post('/api/campaigns/:id/send', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body || {}) as { maxPerSender?: number };
    const requested = Number(body.maxPerSender ?? 200);
    const maxPerSender = Math.min(1000, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 200));

    try {
      const res = await sendCampaignBatch(id, maxPerSender);
      return { ok: true, ...res, campaign: await refreshed(id) };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
  });

  app.post('/api/campaigns/:id/pause', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    camp.status = 'paused';
    await saveCampaign(camp);
    return { ok: true, campaign: await withStats(camp) };
  });

  app.post('/api/campaigns/:id/resume', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    camp.status = 'active';
    await saveCampaign(camp);
    return { ok: true, campaign: await withStats(camp) };
  });
}
