import type { FastifyInstance } from 'fastify';
import { getList } from '../../domain/listStore';
import { getAiSettings } from '../../domain/aiSettings';
import { getAllKnowledge } from '../../domain/knowledgeStore';
import { retrieveContext } from '../../domain/retrieval';
import { generateJson } from '../../lib/ai';
import { hasTimeZoneOffset } from '../../domain/invite';
import { buildAudience, describeEmptyAudience } from '../../domain/audience';
import { createInviteRecord, listInvites, deleteInvite, getInvitedEmails, getInvitedMeta } from '../../domain/inviteStore';
import { labelPreviousInvite } from '../../domain/reinvite';
import { planInviteSplit } from '../../domain/invitePlan';
import { accountAllowances } from '../../domain/inviteCapacity';
import { sendInviteRound } from '../../domain/inviteSend';
import {
  createScheduledInvite,
  getScheduledInvite,
  listScheduledInvites,
  setScheduledInviteStatus,
  type ScheduledInviteRecord,
} from '../../domain/scheduledInviteStore';
import { logger } from '../../lib/logger';

interface InviteEventBody {
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
}

interface CreateInviteBody {
  /** Legacy single-account field; still honoured so a cached client cannot break mid-deploy. */
  connectionId?: string;
  /** Preferred: one or more accounts to split the audience across. */
  connectionIds?: string[];
  listId: string;
  segments?: string[];
  event: InviteEventBody;
  force?: boolean;
  /** When > 0, send in scheduled rounds of up to this many recipients per account. */
  batchSize?: number;
  /** Minutes between rounds; 0 means back-to-back rounds on the next worker tick. */
  delayMinutes?: number;
}

interface PreviewBody {
  listId: string;
  segments?: string[];
}

/** The schedule as the browser needs it: counts and status, never the remaining email addresses. */
function scheduleView(rec: ScheduledInviteRecord) {
  const { remaining, ...rest } = rec;
  return { ...rest, remainingCount: remaining.length };
}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/invites', async () => {
    return { invites: await listInvites() };
  });

  app.delete('/api/invites/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    await deleteInvite(id);
    // A deleted history record must not keep inviting people.
    const schedules = await listScheduledInvites();
    for (const schedule of schedules) {
      if (schedule.inviteId === id && (schedule.status === 'scheduled' || schedule.status === 'paused')) {
        await setScheduledInviteStatus(schedule.id, 'cancelled', 'the invitation history was deleted');
      }
    }
    return { ok: true };
  });

  app.get('/api/invites/schedules', async () => {
    return { schedules: (await listScheduledInvites()).map(scheduleView) };
  });

  app.post('/api/invites/schedules/:id/pause', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const current = await getScheduledInvite(id);
    if (!current) {
      reply.code(404).send({ error: 'scheduled invite not found' });
      return;
    }
    if (current.status !== 'scheduled') {
      reply.code(400).send({ error: 'only a scheduled batch can be paused' });
      return;
    }
    const schedule = await setScheduledInviteStatus(id, 'paused', current.error);
    return { schedule: schedule ? scheduleView(schedule) : schedule };
  });

  app.post('/api/invites/schedules/:id/resume', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const current = await getScheduledInvite(id);
    if (!current) {
      reply.code(404).send({ error: 'scheduled invite not found' });
      return;
    }
    if (current.status !== 'paused') {
      reply.code(400).send({ error: 'only a paused batch can be resumed' });
      return;
    }
    const schedule = await setScheduledInviteStatus(id, 'scheduled', undefined);
    return { schedule: schedule ? scheduleView(schedule) : schedule };
  });

  app.post('/api/invites/schedules/:id/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const current = await getScheduledInvite(id);
    if (!current) {
      reply.code(404).send({ error: 'scheduled invite not found' });
      return;
    }
    if (current.status !== 'scheduled' && current.status !== 'paused') {
      reply.code(400).send({ error: 'this batch has already finished' });
      return;
    }
    const schedule = await setScheduledInviteStatus(id, 'cancelled', 'cancelled by the operator');
    return { schedule: schedule ? scheduleView(schedule) : schedule };
  });

  app.post('/api/invites/preview', async (req, reply) => {
    const b = req.body as PreviewBody;
    const rec = await getList(b.listId);
    if (!rec) {
      reply.code(404).send({ error: 'list not found' });
      return;
    }
    if (!rec.result) {
      reply.code(400).send({ error: 'list has no segmentation result — run Segment first' });
      return;
    }

    const audience = buildAudience(rec.result, b.segments, await getInvitedEmails(b.listId));
    const meta = await getInvitedMeta(b.listId);

    return {
      emails: audience.emails,
      perSegment: audience.perSegment,
      duplicatesRemoved: audience.duplicatesRemoved,
      invalid: audience.invalid,
      alreadyInvited: audience.alreadyInvited,
      // The same people, each with a human label naming the event they were invited to. Returned
      // alongside the plain `alreadyInvited` list so nothing that reads that is affected.
      previouslyInvited: audience.alreadyInvited.map((email) => ({
        email,
        label: labelPreviousInvite(meta[email]),
        meta: meta[email],
      })),
    };
  });

  /**
   * Per-account headroom, for the account picker.
   *
   * Deliberately NOT role-gated, unlike `/api/senders`: sending invitations is open to every role,
   * so the picker has to be able to show what each account can do. It exposes an allowance and a
   * reason only — never profile settings.
   */
  app.post('/api/invites/capacity', async (req) => {
    const b = req.body as { connectionIds?: string[] };
    const ids = Array.isArray(b.connectionIds) ? b.connectionIds.filter(Boolean) : [];
    return { accounts: await accountAllowances(ids, new Date()) };
  });

  app.post('/api/invites/copy', async (req, reply) => {
    const b = req.body as { listId?: string };
    const s = await getAiSettings();
    if (!s || !s.apiKey) {
      reply.code(400).send({ error: 'AI not configured. Set it in Settings → AI.' });
      return;
    }

    let name = '';
    let criteria = '';
    if (b.listId) {
      const rec = await getList(b.listId);
      if (rec) {
        name = rec.name;
        criteria = rec.criteria;
      }
    }

    const kb = await getAllKnowledge();
    const context = retrieveContext(kb, `${criteria} ${name}`);
    const system =
      'You are an event marketer. Draft a concise calendar invitation. Respond with ONLY valid JSON: {"summary":"...","description":"..."}.';
    const prompt = `Knowledge base context:\n${context || '(none)'}\n\nEvent name: ${name || '(unnamed)'}\nCriteria: ${criteria || '(none)'}\n\nWrite a compelling subject line (summary, under 80 chars) and a short, warm description (2-4 sentences) for a webinar/event invite.`;

    try {
      const out = await generateJson<{ summary: string; description: string }>(s, system, prompt);
      return { summary: out.summary, description: out.description };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post('/api/invites', async (req, reply) => {
    const b = req.body as CreateInviteBody;
    const ev = b.event;
    const requestedIds = Array.from(
      new Set([...(Array.isArray(b.connectionIds) ? b.connectionIds : []), b.connectionId].filter(Boolean) as string[]),
    );

    if (!requestedIds.length || !b.listId || !ev || !ev.summary || !ev.start || !ev.end) {
      reply.code(400).send({ error: 'at least one Google account, a listId, event.summary, event.start and event.end are required' });
      return;
    }
    if (Date.parse(ev.end) <= Date.parse(ev.start)) {
      reply.code(400).send({ error: 'event end must be after start' });
      return;
    }
    if (!hasTimeZoneOffset(ev.start) && !(ev.timeZone && ev.timeZone.trim())) {
      reply.code(400).send({ error: 'timeZone is required when start/end have no time-zone offset' });
      return;
    }

    const batching = typeof b.batchSize === 'number' && Number.isFinite(b.batchSize) && b.batchSize > 0;
    const batchSize = batching ? Math.max(1, Math.min(1000, Math.floor(b.batchSize as number))) : 0;
    const delayMinutes = batching ? Math.max(0, Math.floor(Number(b.delayMinutes) || 0)) : 0;
    const delayMs = delayMinutes * 60_000;
    const stopAt = Date.parse(ev.start);
    if (batching && (!Number.isFinite(stopAt) || stopAt <= Date.now())) {
      reply.code(400).send({ error: 'the event must start in the future to send invitations in batches' });
      return;
    }

    // Per-account checks — exists, active, and how much headroom it has left — happen in
    // accountAllowances() below. A missing or paused account is reported as a skip for that
    // account rather than failing the whole send.

    const list = await getList(b.listId);
    if (!list) {
      reply.code(404).send({ error: 'list not found' });
      return;
    }
    if (!list.result) {
      reply.code(400).send({ error: 'list has no segmentation result — run Segment first' });
      return;
    }

    const invited = b.force ? new Set<string>() : await getInvitedEmails(b.listId);
    const audience = buildAudience(list.result, b.segments, invited);
    const emails = audience.emails;

    if (!emails.length) {
      reply.code(400).send({ error: `${describeEmptyAudience(audience)} — use force to resend if you meant to.` });
      return;
    }

    const now = new Date();
    const accounts = await accountAllowances(requestedIds, now);
    // Batched: each account may contribute at most `batchSize` this round, so the rest stays for
    // the schedule. Legacy: the full headroom is placed at once, exactly as before.
    const splitAccounts = batching
      ? accounts.map((account) => ({ ...account, allowance: Math.min(account.allowance, batchSize) }))
      : accounts;
    const split = planInviteSplit(emails, splitAccounts);

    if (!split.totalCapacity) {
      const why = accounts.filter((a) => a.reason).map((a) => `${a.name}: ${a.reason}`).join('; ');
      reply.code(400).send({
        error: `none of the chosen accounts can send right now${why ? ` (${why})` : ''}`,
        accounts,
      });
      return;
    }

    const round = await sendInviteRound({
      listId: b.listId,
      event: ev,
      allocation: split.allocated,
      accounts,
      batchSize: batching ? batchSize : undefined,
      now,
    });

    const { batches, senders, sentEmails } = round;
    const firstError = round.firstError ?? '';

    const status = firstError ? (sentEmails.length ? 'partial' : 'failed') : 'sent';
    const primary = senders.find((s) => s.sent > 0) || senders[0];
    const record = await createInviteRecord({
      listId: b.listId,
      listName: list.name,
      segments: b.segments && b.segments.length ? b.segments : audience.perSegment.map((s) => s.name),
      connectionId: primary.connectionId,
      connectionName: primary.connectionName,
      senders,
      summary: ev.summary,
      start: ev.start,
      end: ev.end,
      timeZone: ev.timeZone,
      recipientCount: sentEmails.length,
      batches,
      status,
      error: firstError || undefined,
    });

    // The remainder of a batched send becomes a schedule; a round that would start after the event
    // is refused up front rather than silently inviting people after the webinar.
    const remaining = Array.from(new Set([...split.unplaced, ...round.failedEmails]));
    let schedule: Awaited<ReturnType<typeof createScheduledInvite>> | null = null;
    let batchWarning: string | undefined;

    if (batching && remaining.length) {
      const nextAt = Date.now() + delayMs;
      if (nextAt >= stopAt) {
        batchWarning = `${remaining.length} people would only be invited after the event starts, so they were left out`;
      } else {
        try {
          schedule = await createScheduledInvite({
            inviteId: record.id,
            listId: b.listId,
            listName: list.name,
            segments: record.segments,
            event: ev,
            connectionIds: requestedIds,
            force: !!b.force,
            batchSize,
            delayMs,
            stopAt,
            remaining,
            rounds: [
              {
                at: now.getTime(),
                completedAt: Date.now(),
                sent: sentEmails.length,
                failed: round.failedEmails.length,
                events: batches.map((batch) => ({
                  connectionId: batch.connectionId ?? '',
                  eventId: batch.eventId,
                  htmlLink: batch.htmlLink,
                  count: batch.count,
                })),
                error: round.firstError,
              },
            ],
            nextAt,
            status: 'scheduled',
          });
        } catch (err) {
          // The first round already went out; losing the schedule must not pretend it did not.
          batchWarning = `the first round was sent, but ${remaining.length} people could not be scheduled: ${(err as Error).message}`;
        }
      }
    }

    return {
      ok: status === 'sent',
      invite: record,
      sent: sentEmails.length,
      failed: senders.reduce((n, s) => n + s.failed, 0),
      schedule: schedule ? scheduleView(schedule) : null,
      batchWarning,
      skipped: {
        duplicatesRemoved: audience.duplicatesRemoved,
        invalid: audience.invalid.length,
        alreadyInvited: audience.alreadyInvited.length,
        unplaced: schedule ? 0 : split.unplaced.length,
        scheduled: schedule ? schedule.remaining.length : 0,
        noCapacity: accounts
          .filter((a) => a.reason)
          .map((a) => ({ connectionId: a.connectionId, name: a.name, reason: a.reason })),
      },
      senders,
    };
  });
}

