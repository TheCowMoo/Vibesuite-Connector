import type { FastifyInstance } from 'fastify';
import { getConnection } from '../../domain/connectionStore';
import { getList } from '../../domain/listStore';
import { getAiSettings } from '../../domain/aiSettings';
import { getAllKnowledge } from '../../domain/knowledgeStore';
import { retrieveContext } from '../../domain/retrieval';
import { generateJson } from '../../lib/ai';
import { createInviteEvent } from '../../google/events';
import { extractRecipients, chunk } from '../../domain/invite';
import { createInviteRecord, listInvites, deleteInvite, getInvitedEmails, markInvited } from '../../domain/inviteStore';
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
  connectionId: string;
  listId: string;
  segments?: string[];
  event: InviteEventBody;
  force?: boolean;
}

interface PreviewBody {
  listId: string;
  segments?: string[];
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

    const plan = extractRecipients(rec.result, b.segments);
    const invited = await getInvitedEmails(b.listId);
    const alreadyInvited = plan.emails.filter((e) => invited.has(e));
    const emails = plan.emails.filter((e) => !invited.has(e));

    return {
      emails,
      perSegment: plan.perSegment,
      duplicatesRemoved: plan.duplicatesRemoved,
      invalid: plan.invalid,
      alreadyInvited,
    };
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
    if (!b.connectionId || !b.listId || !ev || !ev.summary || !ev.start || !ev.end) {
      reply.code(400).send({ error: 'connectionId, listId, event.summary, event.start and event.end are required' });
      return;
    }
    if (Date.parse(ev.end) <= Date.parse(ev.start)) {
      reply.code(400).send({ error: 'event end must be after start' });
      return;
    }

    const conn = await getConnection(b.connectionId);
    if (!conn) {
      reply.code(404).send({ error: 'connection not found' });
      return;
    }
    if (conn.status !== 'active') {
      reply.code(400).send({ error: 'connection is not active — connect Google first' });
      return;
    }

    const list = await getList(b.listId);
    if (!list) {
      reply.code(404).send({ error: 'list not found' });
      return;
    }
    if (!list.result) {
      reply.code(400).send({ error: 'list has no segmentation result — run Segment first' });
      return;
    }

    const plan = extractRecipients(list.result, b.segments);
    const invited = b.force ? new Set<string>() : await getInvitedEmails(b.listId);
    const emails = plan.emails.filter((e) => !invited.has(e));

    if (!emails.length) {
      reply.code(400).send({ error: 'no recipients to invite (all already invited or no valid emails). Use force to resend.' });
      return;
    }

    const chunks = chunk(emails, env.INVITE_BATCH_SIZE);
    const batches: Array<{ chunk: number; eventId: string; htmlLink?: string; count: number }> = [];
    const sentEmails: string[] = [];
    let firstError = '';

    for (let i = 0; i < chunks.length; i++) {
      const part = chunks[i];
      const summary = chunks.length > 1 ? `${ev.summary} (${i + 1}/${chunks.length})` : ev.summary;
      try {
        const res = await withRetry(() => createInviteEvent(conn, { ...ev, summary, emails: part }), { retries: 3 });
        batches.push({ chunk: i + 1, eventId: res.id, htmlLink: res.htmlLink, count: part.length });
        sentEmails.push(...part);
      } catch (err) {
        firstError = firstError || (err as Error).message;
        logger.error({ connectionId: conn.id, listId: b.listId, chunk: i + 1, err: (err as Error).message }, 'invite chunk failed');
      }
      if (i < chunks.length - 1) await sleep(env.INVITE_DELAY_MS);
    }

    if (sentEmails.length) await markInvited(b.listId, sentEmails);

    const status = firstError ? (sentEmails.length ? 'partial' : 'failed') : 'sent';
    const record = await createInviteRecord({
      listId: b.listId,
      listName: list.name,
      segments: b.segments && b.segments.length ? b.segments : plan.perSegment.map((s) => s.name),
      connectionId: conn.id,
      connectionName: conn.name,
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
      failed: emails.length - sentEmails.length,
      skipped: {
        duplicatesRemoved: plan.duplicatesRemoved,
        invalid: plan.invalid.length,
        alreadyInvited: plan.emails.length - emails.length,
      },
    };
  });
}

