import type { FastifyInstance } from 'fastify';
import { createList, listLists, getList, saveListResult, deleteList } from '../../domain/listStore';
import { getAiSettings } from '../../domain/aiSettings';
import { getAllKnowledge } from '../../domain/knowledgeStore';
import { retrieveContext } from '../../domain/retrieval';
import {
  assertListSize,
  assertSegmentable,
  buildSegmentPrompt,
  listDataRows,
  mergeIndexedSegments,
  SegmentationFormatError,
  SegmentationInputError,
  SEGMENT_MAX_CHARS,
  SEGMENT_SYNC_MAX_ROWS,
  SEGMENT_SYSTEM_PROMPT,
  LIST_MAX_CHARS,
  LIST_MAX_ROWS,
} from '../../domain/listSegment';
import {
  listSummaryView,
  listView,
  publicListVerificationStatus,
  publicSegmentationStatus,
} from '../../domain/listView';
import {
  cancelListVerification,
  deleteListVerification,
  enqueueListVerification,
  getListVerificationStatus,
  getListVerificationStatuses,
} from '../../domain/listVerificationQueue';
import {
  cancelListSegmentation,
  deleteListSegmentation,
  enqueueListSegmentation,
  getListSegmentStatus,
  getListSegmentStatuses,
} from '../../domain/listSegmentQueue';
import { AiJsonError, generateJson } from '../../lib/ai';
import { logger } from '../../lib/logger';
import { env } from '../../config/env';

export async function listRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/lists', async () => {
    const lists = await listLists();
    const ids = lists.map((list) => list.id);
    const [statuses, verifications] = await Promise.all([
      getListSegmentStatuses(ids),
      getListVerificationStatuses(ids),
    ]);
    return {
      lists: lists.map((list) =>
        listSummaryView(list, statuses[list.id] ?? null, verifications[list.id] ?? null),
      ),
      verificationConfig: {
        costPer1000: env.EMAIL_VERIFY_COST_PER_1000,
        maxPerRun: env.EMAIL_VERIFY_MAX_PER_RUN,
      },
    };
  });

  app.post('/api/lists', async (req, reply) => {
    const b = req.body as { name?: string; content?: string; criteria?: string };
    if (!b.content) {
      reply.code(400).send({ error: 'content is required' });
      return;
    }

    const rows = listDataRows(b.content);
    try {
      assertListSize(rows, b.content.length);
    } catch (err) {
      if (err instanceof SegmentationInputError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }

    const rec = await createList(b.name || 'Untitled list', b.content, b.criteria || '', rows.length);
    return { list: listView(rec, null, null) };
  });

  app.get('/api/lists/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = await getList(id);
    if (!rec) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const [status, verification] = await Promise.all([
      getListSegmentStatus(id),
      getListVerificationStatus(id),
    ]);
    return { list: listView(rec, status, verification) };
  });

  app.get('/api/lists/:id/segment/status', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const status = await getListSegmentStatus(id);
    if (!status) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    return { segmentation: publicSegmentationStatus(status) };
  });

  app.post('/api/lists/:id/segment/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const status = await cancelListSegmentation(id);
    if (!status) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    return { ok: true, segmentation: publicSegmentationStatus(status) };
  });

  app.post('/api/lists/:id/segment', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = await getList(id);
    if (!rec) {
      reply.code(404).send({ error: 'not found' });
      return;
    }

    const rows = listDataRows(rec.content);
    try {
      assertSegmentable(rows, rec.content.length, LIST_MAX_ROWS, LIST_MAX_CHARS);
    } catch (err) {
      if (err instanceof SegmentationInputError) {
        reply.code(400).send({ error: err.message });
        return;
      }
      throw err;
    }

    const settings = await getAiSettings();
    if (!settings || !settings.apiKey) {
      reply.code(400).send({ error: 'AI not configured. Set it in Settings → AI.' });
      return;
    }

    if (rows.length > SEGMENT_SYNC_MAX_ROWS || rec.content.length > SEGMENT_MAX_CHARS) {
      try {
        const status = await enqueueListSegmentation(id, rows.length);
        reply.code(202).send({ ok: true, segmentation: publicSegmentationStatus(status) });
      } catch (err) {
        logger.error({ err, listId: id }, 'could not queue list segmentation');
        reply.code(502).send({ error: 'Could not queue the list sort. Try again.' });
      }
      return;
    }

    const kb = await getAllKnowledge();
    const context = retrieveContext(kb, `${rec.criteria} ${rec.name}`);
    const prompt = buildSegmentPrompt({ rows, criteria: rec.criteria, context });

    try {
      const raw = await generateJson<unknown>(settings, SEGMENT_SYSTEM_PROMPT, prompt, {
        maxTokens: 8192,
        jsonMode: true,
      });
      const result = mergeIndexedSegments(raw, rows);
      await saveListResult(id, result);
      return { ok: true, result };
    } catch (err) {
      if (err instanceof AiJsonError || err instanceof SegmentationFormatError) {
        logger.warn({ err, listId: id }, 'list segmentation returned an unusable AI response');
        reply.code(502).send({
          error:
            'The AI returned an incomplete segmentation. Try again, choose a model with a larger output limit, or split the list into smaller lists.',
        });
        return;
      }
      logger.error({ err, listId: id }, 'list segmentation failed');
      const detail = ((err as Error).message || 'unknown error').replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1***');
      reply.code(502).send({ error: `The AI could not sort this list: ${detail}` });
    }
  });

  app.get('/api/lists/:id/verify', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await getList(id))) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const status = await getListVerificationStatus(id);
    if (!status) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    return { verification: publicListVerificationStatus(status) };
  });

  app.post('/api/lists/:id/verify/cancel', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!(await getList(id))) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const status = await cancelListVerification(id);
    if (!status) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    return { ok: true, verification: publicListVerificationStatus(status) };
  });

  app.post('/api/lists/:id/verify', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = await getList(id);
    if (!rec) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    if (!rec.result) {
      reply.code(400).send({ error: 'list has no segmentation result — run Segment first' });
      return;
    }

    const b = (req.body || {}) as { connectionId?: string; segments?: unknown; maxChecks?: unknown };
    const connectionId = typeof b.connectionId === 'string' ? b.connectionId.trim() : '';
    if (!connectionId) {
      reply.code(400).send({ error: 'connectionId is required' });
      return;
    }
    const segments = Array.isArray(b.segments)
      ? b.segments.map((s) => String(s)).filter(Boolean)
      : undefined;
    const maxChecks = typeof b.maxChecks === 'number' ? b.maxChecks : undefined;

    try {
      const status = await enqueueListVerification(id, { connectionId, segments, maxChecks });
      reply.code(202).send({ ok: true, verification: publicListVerificationStatus(status) });
    } catch (err) {
      logger.warn({ err, listId: id }, 'could not queue list email verification');
      reply.code(400).send({ error: (err as Error).message || 'could not queue email verification' });
    }
  });

  app.delete('/api/lists/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    await cancelListSegmentation(id);
    await cancelListVerification(id);
    await deleteList(id);
    await deleteListSegmentation(id);
    await deleteListVerification(id);
    return { ok: true };
  });
}
