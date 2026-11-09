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
import { listSummaryView, listView, publicSegmentationStatus } from '../../domain/listView';
import {
  cancelListSegmentation,
  deleteListSegmentation,
  enqueueListSegmentation,
  getListSegmentStatus,
  getListSegmentStatuses,
} from '../../domain/listSegmentQueue';
import { AiJsonError, generateJson } from '../../lib/ai';
import { logger } from '../../lib/logger';

export async function listRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/lists', async () => {
    const lists = await listLists();
    const statuses = await getListSegmentStatuses(lists.map((list) => list.id));
    return { lists: lists.map((list) => listSummaryView(list, statuses[list.id] ?? null)) };
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
    return { list: listView(rec, null) };
  });

  app.get('/api/lists/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const rec = await getList(id);
    if (!rec) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    const status = await getListSegmentStatus(id);
    return { list: listView(rec, status) };
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

  app.delete('/api/lists/:id', async (req) => {
    const id = (req.params as { id: string }).id;
    await cancelListSegmentation(id);
    await deleteList(id);
    await deleteListSegmentation(id);
    return { ok: true };
  });
}
