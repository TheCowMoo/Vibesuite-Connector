import type { FastifyInstance } from 'fastify';
import {
  CampaignSchema,
  invitedByDeadline,
  planSchedule,
  type Campaign,
} from '../../domain/campaign';
import { resolveSendPlan, stopTimeError } from '../../domain/campaignLifecycle';
import { applyCampaignZoomHost } from '../../domain/campaignZoom';
import { getZoomAccount } from '../../domain/zoomStore';
import {
  acquireCampaignTestCopyLock,
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
import { sendCampaignBatch, sendCampaignTestCopy, startCampaign, endCampaign } from '../../domain/campaignDispatch';
import { mirrorPrimaryVariant } from '../../domain/campaignVariants';
import { getSenderProfile } from '../../domain/senderStore';
import { getList } from '../../domain/listStore';
import { getInvitedEmails } from '../../domain/inviteStore';
import { buildAudience } from '../../domain/audience';
import { collectCampaignStats } from '../../domain/campaignStatsCollect';
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

/**
 * The stop-time rules, applied to whatever is about to be stored.
 *
 * Shares `stopTimeError()` with the wizard's `resolveSendPlan()`, so a deadline the API accepts and
 * one the UI accepts are judged by the same code.
 */
function sendByError(c: { sendByAt?: number; scheduledStartAt?: number }, now: number): string | undefined {
  return stopTimeError(c, now);
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

    // A draft has nothing frozen yet, so count the live audience. Without this the planner walks
    // zero days, and the UI cannot say how long a send will take before it has started — which is
    // the only moment the estimate is actually useful.
    let total = counts.total;
    if (total === 0) {
      const list = await getList(camp.listId);
      if (list && list.result) {
        const invited = camp.includeAlreadyInvited ? new Set<string>() : await getInvitedEmails(camp.listId);
        total = buildAudience(list.result, camp.segments, invited).emails.length;
      }
    }
    if (total === 0) total = Math.max(0, Number(q.total ?? 0) || 0);
    const startDate = q.startDate && /^\d{4}-\d{2}-\d{2}$/.test(q.startDate) ? q.startDate : todayISO();

    const senders = await Promise.all(
      camp.senders
        .filter((s) => s.enabled)
        .map(async (s) => ({ connectionId: s.connectionId, profile: await getSenderProfile(s.connectionId) })),
    );

    const plan = planSchedule({ total, senders, startDate });
    const byDeadline = camp.sendByAt !== undefined ? invitedByDeadline(plan, camp.sendByAt) : null;
    return {
      total,
      startDate,
      dailyCapacity: plan.days.length ? plan.days[0].total : 0,
      ...plan,
      // Computed here, against timestamps, so the UI does not have to guess at UTC vs local dates.
      byDeadline,
      shortfall: byDeadline === null ? 0 : Math.max(0, total - byDeadline),
      spread: camp.distribution.mode,
    };
  });

  /**
   * The same estimate as `/api/campaigns/:id/plan`, for a campaign that does not exist yet.
   *
   * Reuses `buildAudience()` (exactly what Begin sending freezes) and `planSchedule()`, so the pace
   * an operator is shown while filling in the wizard is the pace the send will actually follow.
   */
  app.post('/api/campaigns/plan-preview', async (req, reply) => {
    const b = (req.body || {}) as {
      listId?: string;
      segments?: string[];
      connectionIds?: string[];
      startDate?: string;
      stopBy?: number;
      includeAlreadyInvited?: boolean;
    };

    if (!b.listId) {
      reply.code(400).send({ error: 'pick a contact list first' });
      return;
    }
    const list = await getList(b.listId);
    if (!list || !list.result) {
      reply.code(400).send({ error: 'list has no segmentation result — run Segment first' });
      return;
    }

    const invited = b.includeAlreadyInvited ? new Set<string>() : await getInvitedEmails(b.listId);
    const audience = buildAudience(list.result, b.segments ?? [], invited);
    const total = audience.emails.length;

    const senders = await Promise.all(
      (b.connectionIds ?? [])
        .filter(Boolean)
        .map(async (connectionId) => ({ connectionId, profile: await getSenderProfile(connectionId) })),
    );

    const startDate = b.startDate && /^\d{4}-\d{2}-\d{2}$/.test(b.startDate) ? b.startDate : todayISO();
    const plan = planSchedule({ total, senders, startDate });

    const stopBy = Number(b.stopBy);
    const byDeadline = Number.isFinite(stopBy) ? invitedByDeadline(plan, stopBy) : null;

    return {
      total,
      startDate,
      dailyCapacity: plan.days.length ? plan.days[0].total : 0,
      ...plan,
      byDeadline,
      shortfall: byDeadline === null ? 0 : Math.max(0, total - byDeadline),
      alreadyInvited: audience.alreadyInvited.length,
    };
  });

  /** Sends, RSVP funnel and session attendance — attributed per sending mailbox. */
  app.get('/api/campaigns/:id/stats', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }

    return { stats: await collectCampaignStats(camp), sessionId: camp.sessionId ?? null };
  });

  app.post('/api/campaigns', guard, async (req, reply) => {
    const schema = CampaignSchema.omit({ id: true, createdAt: true });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid campaign', details: parsed.error.flatten().fieldErrors });
      return;
    }

    // Variant A is the base copy; keep the legacy event fields in step with it so cards, attendance
    // labels and older clients all read the same subject.
    const data = mirrorPrimaryVariant(parsed.data);
    const stopProblem = sendByError(data, Date.now());
    if (stopProblem) {
      reply.code(400).send({ error: stopProblem });
      return;
    }

    const camp = await createCampaign(data);
    if (camp.zoomUserId) {
      // Also stamps the linked session, so attendance sync knows whose Zoom to read.
      await applyCampaignZoomHost({ campaign: camp, zoomUserId: camp.zoomUserId, previousZoomUserId: undefined });
    }
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

    const body = (req.body || {}) as Record<string, unknown>;
    if ('copyVariants' in body && camp.startedAt) {
      reply.code(400).send({ error: 'copy variants are frozen once sending has started' });
      return;
    }

    // Only judge the stop time when this edit actually touched it, so renaming a paused campaign
    // whose deadline has already lapsed stays possible.
    if ('sendByAt' in body || 'scheduledStartAt' in body) {
      const stopProblem = sendByError(parsed.data, Date.now());
      if (stopProblem) {
        reply.code(400).send({ error: stopProblem });
        return;
      }
    }

    const next = mirrorPrimaryVariant(parsed.data);
    await saveCampaign(next);
    if ('zoomUserId' in body) {
      await applyCampaignZoomHost({
        campaign: next,
        zoomUserId: next.zoomUserId,
        previousZoomUserId: camp.zoomUserId,
      });
    }
    return { ok: true, campaign: await withStats(next) };
  });

  /**
   * Send one variant's copy as a real calendar invite to test addresses.
   *
   * No queue, recipient, cap, stat or invited-set changes: this is a test, not a send. The event is
   * marked `[TEST]` and its RSVPs are ignored by the sync pipeline.
   */
  app.post('/api/campaigns/:id/test-copy', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    if (camp.status === 'completed' || camp.status === 'ended') {
      reply.code(400).send({ error: 'this campaign has finished; create a new one to test copy' });
      return;
    }

    const body = (req.body || {}) as { emails?: unknown; variantId?: string; connectionId?: string };
    if (!Array.isArray(body.emails) || !body.emails.length) {
      reply.code(400).send({ error: 'emails must be a non-empty array' });
      return;
    }
    if (!(await acquireCampaignTestCopyLock(id))) {
      reply.code(429).send({ error: 'a test copy was just sent — wait a few seconds and try again' });
      return;
    }

    try {
      const result = await sendCampaignTestCopy(camp, {
        emails: body.emails.map(String),
        variantId: body.variantId,
        connectionId: body.connectionId,
      });
      return { ok: true, ...result };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
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

  /** Put a draft or paused campaign on a timer, with an optional deadline. */
  app.post('/api/campaigns/:id/schedule', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    if (camp.status === 'active' || camp.status === 'completed' || camp.status === 'ended') {
      reply.code(400).send({ error: 'only a draft or paused campaign can be scheduled' });
      return;
    }

    const b = (req.body || {}) as { startAt?: number; sendByAt?: number };
    const plan = resolveSendPlan({
      startMode: 'later',
      startAt: b.startAt ?? undefined,
      stopBy: b.sendByAt ?? undefined,
      now: Date.now(),
    });
    if (plan.error) {
      reply.code(400).send({ error: plan.error });
      return;
    }

    camp.scheduledStartAt = plan.scheduledStartAt;
    camp.sendByAt = plan.sendByAt;
    camp.status = 'scheduled';
    camp.lastError = undefined;
    await saveCampaign(camp);

    return { ok: true, campaign: await withStats(camp) };
  });

  /** Take a campaign back off the timer. It returns to being a draft, not an ended one. */
  app.post('/api/campaigns/:id/unschedule', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    if (camp.status !== 'scheduled') {
      reply.code(400).send({ error: 'this campaign is not scheduled' });
      return;
    }

    camp.status = 'draft';
    camp.scheduledStartAt = undefined;
    camp.lastError = undefined;
    await saveCampaign(camp);

    return { ok: true, campaign: await withStats(camp) };
  });

  /**
   * Add, change or clear the stop time on its own.
   *
   * This is what makes "begin now, stop on Friday" possible: before it, a deadline could only be
   * attached while scheduling a *future* start, so a running campaign could never be bounded.
   */
  app.post('/api/campaigns/:id/deadline', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    if (camp.status === 'ended' || camp.status === 'completed') {
      reply.code(400).send({ error: 'this campaign has already finished' });
      return;
    }

    const b = (req.body || {}) as { sendByAt?: number | null };

    // Absent or null clears the deadline; the scheduler then simply stops ending the campaign.
    if (b.sendByAt === undefined || b.sendByAt === null) {
      camp.sendByAt = undefined;
      await saveCampaign(camp);
      return { ok: true, campaign: await withStats(camp) };
    }

    const sendByAt = Number(b.sendByAt);
    if (!Number.isFinite(sendByAt)) {
      reply.code(400).send({ error: 'the stop time is not valid' });
      return;
    }
    const problem = sendByError({ sendByAt, scheduledStartAt: camp.status === 'scheduled' ? camp.scheduledStartAt : undefined }, Date.now());
    if (problem) {
      reply.code(400).send({ error: problem });
      return;
    }

    camp.sendByAt = sendByAt;
    await saveCampaign(camp);
    return { ok: true, campaign: await withStats(camp) };
  });

  /**
   * Choose (or clear) this campaign's Zoom host.
   *
   * One campaign = one webinar = one host. The host itself lives in the shared pool, so several
   * campaigns can reuse the same authorisation, and the linked session is stamped so `syncSession()`
   * reads the right account without a reverse lookup.
   */
  app.post('/api/campaigns/:id/zoom', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    if (camp.status === 'ended' || camp.status === 'completed') {
      reply.code(400).send({ error: 'this campaign has finished' });
      return;
    }

    const b = (req.body || {}) as { zoomUserId?: string | null };
    const next = b.zoomUserId === undefined || b.zoomUserId === null ? undefined : String(b.zoomUserId);

    if (next && !(await getZoomAccount(next))) {
      reply.code(400).send({ error: 'that Zoom account is not connected — connect it first' });
      return;
    }

    const updated = await applyCampaignZoomHost({
      campaign: camp,
      zoomUserId: next,
      previousZoomUserId: camp.zoomUserId,
    });
    return { ok: true, campaign: await withStats(updated) };
  });

  /**
   * Stop sending for good. Anyone already invited keeps their calendar invitation — this only halts
   * future sends, and the untouched recipients stay uninvited.
   */
  app.post('/api/campaigns/:id/end', guard, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const camp = await getCampaign(id);
    if (!camp) {
      reply.code(404).send({ error: 'campaign not found' });
      return;
    }
    if (camp.status !== 'active' && camp.status !== 'paused') {
      reply.code(400).send({ error: 'only a running or paused campaign can be ended' });
      return;
    }

    const ended = await endCampaign(id);
    return { ok: true, campaign: ended ? await withStats(ended) : null };
  });
}
