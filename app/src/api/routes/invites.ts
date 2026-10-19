import type { FastifyInstance } from 'fastify';
import { getConnection } from '../../domain/connectionStore';
import { getList } from '../../domain/listStore';
import { getAiSettings } from '../../domain/aiSettings';
import { getAllKnowledge } from '../../domain/knowledgeStore';
import { retrieveContext } from '../../domain/retrieval';
import { generateJson } from '../../lib/ai';
import { createInviteEvent } from '../../google/events';
import { chunk, hasTimeZoneOffset } from '../../domain/invite';
import { buildAudience, describeEmptyAudience } from '../../domain/audience';
import { createInviteRecord, listInvites, deleteInvite, getInvitedEmails, getInvitedMeta, markInvited, type InviteSenderSummary } from '../../domain/inviteStore';
import { labelPreviousInvite } from '../../domain/reinvite';
import { bumpSenderDay, bumpSenderHour, getSenderGauge, isoHour } from '../../domain/senderStore';
import { senderReadiness } from '../../domain/campaignSchedule';
import { isoDate } from '../../domain/senderLoad';
import { planInviteSplit, type AccountAllowance } from '../../domain/invitePlan';
import { withRetry, sleep } from '../../lib/backoff';
import { env } from '../../config/env';
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
}

interface PreviewBody {
  listId: string;
  segments?: string[];
}

function describeError(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } | string } }; message?: string };
  const status = e?.response?.status;
  const d = e?.response?.data?.error;
  const detail = typeof d === 'string' ? d : d?.message;
  const base = detail || e?.message || 'unknown error';
  return status ? `${status} ${base}` : base;
}

interface AccountCapacity extends AccountAllowance {
  name: string;
}

/**
 * How much each chosen account can still send right now, and why not when it can't.
 *
 * The same `senderReadiness()` the campaign scheduler uses, so the numbers shown before a send are
 * the numbers the send itself honours. These counters are per *mailbox*, not per feature, so any
 * campaigns running on the same account share this budget — an invite sent here consumes it.
 */
async function accountAllowances(connectionIds: string[], now: Date): Promise<AccountCapacity[]> {
  return Promise.all(
    connectionIds.map(async (connectionId) => {
      const conn = await getConnection(connectionId);
      const name = conn?.name || connectionId;
      if (!conn) return { connectionId, name, allowance: 0, reason: 'account not found' };
      if (conn.status !== 'active') return { connectionId, name, allowance: 0, reason: 'not connected to Google' };

      const gauge = await getSenderGauge(connectionId, now);
      const readiness = senderReadiness({
        enabled: gauge.profile.enabled,
        inWindow: gauge.inWindow,
        coolingUntil: gauge.state.cooldownUntil,
        now: now.getTime(),
        capToday: gauge.capToday,
        sentToday: gauge.sentToday,
        hourlyCap: gauge.profile.hourlyCap,
        sentThisHour: gauge.sentThisHour,
      });

      return readiness.ready
        ? { connectionId, name, allowance: readiness.allowance }
        : { connectionId, name, allowance: 0, reason: readiness.reason };
    }),
  );
}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/invites', async () => {
    return { invites: await listInvites() };
  });

  app.delete('/api/invites/:id', async (req) => {
    await deleteInvite((req.params as { id: string }).id);
    return { ok: true };
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
    const split = planInviteSplit(emails, accounts);

    if (!split.totalCapacity) {
      const why = accounts.filter((a) => a.reason).map((a) => `${a.name}: ${a.reason}`).join('; ');
      reply.code(400).send({
        error: `none of the chosen accounts can send right now${why ? ` (${why})` : ''}`,
        accounts,
      });
      return;
    }

    const batches: Array<{ chunk: number; eventId: string; htmlLink?: string; count: number }> = [];
    const senders: InviteSenderSummary[] = [];
    const sentEmails: string[] = [];
    let firstError = '';

    for (const account of accounts) {
      const slice = split.allocated[account.connectionId] || [];
      const row: InviteSenderSummary = {
        connectionId: account.connectionId,
        connectionName: account.name,
        sent: 0,
        failed: 0,
        skippedReason: account.reason,
      };
      senders.push(row);
      if (!slice.length) continue;

      const conn = await getConnection(account.connectionId);
      if (!conn) {
        row.skippedReason = 'account not found';
        continue;
      }

      // Chunk per mailbox rather than across the whole audience. With one chunk each — the normal
      // case once the list is spread — no numbered suffix appears at all, so a guest never receives
      // something titled "Webinar (3/5)". The suffix only returns if one account needs splitting.
      const parts = chunk(slice, env.INVITE_BATCH_SIZE);

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const summary = parts.length > 1 ? `${ev.summary} (${i + 1}/${parts.length})` : ev.summary;
        try {
          const res = await withRetry(() => createInviteEvent(conn, { ...ev, summary, emails: part }), { retries: 3 });
          batches.push({ chunk: batches.length + 1, eventId: res.id, htmlLink: res.htmlLink, count: part.length });
          sentEmails.push(...part);
          row.sent += part.length;
          // Spend the shared per-mailbox budget. Without this the caps we just read would never be
          // consumed, so every send would see the same full headroom — and campaigns on the same
          // account would not see this usage either.
          await bumpSenderDay(conn.id, isoDate(now), 'sent', part.length);
          await bumpSenderHour(conn.id, isoHour(now), part.length);
        } catch (err) {
          const msg = describeError(err);
          firstError = firstError || msg;
          row.failed += part.length;
          await bumpSenderDay(conn.id, isoDate(now), 'failed', part.length);
          logger.error({ connectionId: conn.id, listId: b.listId, chunk: i + 1, err: msg }, 'invite chunk failed');
        }
        if (i < parts.length - 1) await sleep(env.INVITE_DELAY_MS);
      }

      // Small gap between mailboxes so several accounts never hit Google in lockstep.
      await sleep(env.INVITE_DELAY_MS);
    }

    if (sentEmails.length) {
      await markInvited(b.listId, sentEmails, {
        summary: ev.summary,
        start: ev.start,
        source: 'invite',
      });
    }

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

    return {
      ok: status === 'sent',
      invite: record,
      sent: sentEmails.length,
      failed: senders.reduce((n, s) => n + s.failed, 0),
      skipped: {
        duplicatesRemoved: audience.duplicatesRemoved,
        invalid: audience.invalid.length,
        alreadyInvited: audience.alreadyInvited.length,
        unplaced: split.unplaced.length,
        noCapacity: accounts
          .filter((a) => a.reason)
          .map((a) => ({ connectionId: a.connectionId, name: a.name, reason: a.reason })),
      },
      senders,
    };
  });
}

