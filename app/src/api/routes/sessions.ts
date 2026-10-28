import type { FastifyInstance } from 'fastify';
import { createSession, getSession, listSessions, deleteSession, saveSession } from '../../domain/sessionStore';
import { getAttendance } from '../../domain/attendanceStore';
import { syncSession, dispatchSession } from '../../workers/attendance';
import { getProvider } from '../../video';
import { normalizeZoomCallId } from '../../video/zoomId';
import type { SessionType, VideoProvider } from '../../video/types';

export async function sessionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sessions', async () => {
    return { sessions: await listSessions() };
  });

  app.post('/api/sessions', async (req, reply) => {
    const b = req.body as {
      provider: VideoProvider;
      sessionType?: SessionType;
      externalId: string;
      title: string;
      startTime: string;
      endTime: string;
      joinUrl?: string;
      connectionId?: string;
      zoomUserId?: string;
      inviteId?: string;
      listId?: string;
    };
    if (!b.provider || !b.externalId || !b.title || !b.startTime || !b.endTime) {
      reply.code(400).send({ error: 'provider, externalId, title, startTime and endTime are required' });
      return;
    }
    if (b.provider === 'zoom') {
      const normalized = normalizeZoomCallId(b.externalId);
      if (!normalized) {
        reply.code(400).send({
          error: 'That does not look like a Zoom meeting or webinar ID. Paste the numeric ID or the join link.',
        });
        return;
      }
      b.externalId = normalized.id;
      // A /w/ or /register/ link is only ever a webinar; trusting it avoids a sync that 404s
      // against the meeting endpoints.
      if (normalized.kind) b.sessionType = normalized.kind;
    }
    // Fill in the real join link when the operator did not paste one. Best-effort: a Zoom app
    // without the `webinar:read` / `meeting:read` scope simply resolves nothing and the session
    // saves exactly as it did before.
    if (!b.joinUrl) {
      try {
        const resolved = await getProvider(b.provider).resolveJoinUrl?.(b.externalId, b.sessionType ?? 'meeting', {
          connectionId: b.connectionId,
          zoomUserId: b.zoomUserId,
        });
        if (resolved) b.joinUrl = resolved;
      } catch {
        /* leave it blank; the dispatcher still has its synthesised fallback */
      }
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

  /**
   * Correct a call after creation.
   *
   * The type, ID and host are exactly what make a sync 404, and deleting/recreating the call would
   * lose its campaign link, so they are editable here. Changing one of them resets the sync state so
   * the scheduler tries again; renaming a call leaves its report alone.
   */
  app.patch('/api/sessions/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const session = await getSession(id);
    if (!session) {
      reply.code(404).send({ error: 'not found' });
      return;
    }

    const b = req.body as {
      title?: string;
      sessionType?: SessionType;
      externalId?: string;
      zoomUserId?: string | null;
      listId?: string | null;
      connectionId?: string | null;
    };

    let changed = false;
    /** Only ID/type/host invalidate a report; renaming a call must not throw its sync away. */
    let syncRelevant = false;

    if (b.title !== undefined) {
      const title = String(b.title).trim();
      if (!title) {
        reply.code(400).send({ error: 'the title cannot be empty' });
        return;
      }
      session.title = title;
      changed = true;
    }

    if (b.sessionType !== undefined) {
      if (b.sessionType !== 'meeting' && b.sessionType !== 'webinar') {
        reply.code(400).send({ error: 'sessionType must be meeting or webinar' });
        return;
      }
      session.sessionType = b.sessionType;
      changed = true;
      syncRelevant = true;
    }

    if (b.externalId !== undefined) {
      const externalId = String(b.externalId).trim();
      if (!externalId) {
        reply.code(400).send({ error: 'the call ID cannot be empty' });
        return;
      }

      if (session.provider === 'zoom') {
        const normalized = normalizeZoomCallId(externalId);
        if (!normalized) {
          reply.code(400).send({
            error: 'That does not look like a Zoom meeting or webinar ID. Paste the numeric ID or the join link.',
          });
          return;
        }
        session.externalId = normalized.id;
        if (normalized.kind) session.sessionType = normalized.kind;
      } else {
        session.externalId = externalId;
      }
      // The old link belongs to the old ID.
      session.joinUrl = undefined;
      changed = true;
      syncRelevant = true;
    }

    if (b.zoomUserId !== undefined) {
      session.zoomUserId = b.zoomUserId ? String(b.zoomUserId) : undefined;
      changed = true;
      syncRelevant = true;
    }

    if (b.listId !== undefined) {
      session.listId = b.listId ? String(b.listId) : undefined;
      changed = true;
      syncRelevant = true;
    }

    if (b.connectionId !== undefined) {
      session.connectionId = b.connectionId ? String(b.connectionId) : undefined;
      // Delivery now targets a different account; let the roster reach its new endpoint.
      session.rosterRevision = undefined;
      changed = true;
      syncRelevant = true;
    }

    if (syncRelevant) {
      session.status = 'pending';
      session.lastSyncedAt = undefined;
      session.error = undefined;
      session.warnings = undefined;
      session.syncDiagnostics = undefined;
    }

    if (!changed) return { session };

    await saveSession(session);
    return { session };
  });

  app.post('/api/sessions/:id/sync', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const report = await syncSession(id);
      // `status` tells the panel whether this was a real report or one Zoom has not published yet.
      const session = await getSession(id);
      return { ok: true, report, status: session?.status ?? 'synced' };
    } catch (err) {
      reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.post('/api/sessions/:id/dispatch', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const b = (req.body || {}) as { rosterOnly?: boolean; forceRoster?: boolean };
      const res = await dispatchSession(id, { rosterOnly: !!b.rosterOnly, forceRoster: !!b.forceRoster });
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
