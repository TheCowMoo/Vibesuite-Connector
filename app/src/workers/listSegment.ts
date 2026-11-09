import { env } from '../config/env';
import { logger } from '../lib/logger';
import { generateJson } from '../lib/ai';
import { getAiSettings, type AiSettings } from '../domain/aiSettings';
import { getAllKnowledge } from '../domain/knowledgeStore';
import { retrieveContext } from '../domain/retrieval';
import { getList, saveListResult } from '../domain/listStore';
import {
  assertSegmentable,
  listDataRows,
  LIST_MAX_CHARS,
  LIST_MAX_ROWS,
} from '../domain/listSegment';
import {
  ASSIGNMENT_SYSTEM_PROMPT,
  batchRows,
  buildAssignmentPrompt,
  buildTaxonomyPrompt,
  mergeBatchResults,
  parseBatchAssignments,
  parseTaxonomy,
  sampleRows,
  TAXONOMY_SYSTEM_PROMPT,
  type BatchResult,
  type BatchChunk,
  type TaxonomySegment,
} from '../domain/listSegmentBatch';
import {
  deleteListSegmentBatches,
  getListSegmentBatches,
  getListSegmentStatus,
  saveListSegmentBatch,
  saveListSegmentStatus,
  updateListSegmentStatus,
  type ListSegmentationStatus,
} from '../domain/listSegmentStore';
import { forEachLimit, withRetry } from '../domain/concurrency';

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || 'unknown error');
  return message.replace(/([?&](?:key|api_key)=)[^&\s]+/gi, '$1***').slice(0, 500);
}

async function failRun(listId: string, runId: string, err: unknown): Promise<void> {
  const status = await getListSegmentStatus(listId);
  if (!status || status.runId !== runId) return;
  await saveListSegmentStatus(listId, {
    ...status,
    status: 'failed',
    error: safeError(err),
    finishedAt: Date.now(),
  });
}

async function cancelRun(listId: string, runId: string): Promise<void> {
  const status = await getListSegmentStatus(listId);
  if (!status || status.runId !== runId) return;
  await saveListSegmentStatus(listId, {
    ...status,
    status: 'cancelled',
    cancelRequested: true,
    finishedAt: Date.now(),
  });
}

function initialStatus(runId: string, totalRows: number, totalBatches: number): ListSegmentationStatus {
  return {
    status: 'running',
    runId,
    totalRows,
    processedRows: 0,
    totalBatches,
    processedBatches: 0,
    createdAt: Date.now(),
    startedAt: Date.now(),
  };
}

async function callAssignment(
  settings: AiSettings,
  listId: string,
  batch: BatchChunk,
  totalBatches: number,
  taxonomy: TaxonomySegment[],
  criteria: string,
  context: string,
): Promise<BatchResult> {
  const status = await getListSegmentStatus(listId);
  if (!status) {
    throw new Error('The list sort status disappeared before this batch started.');
  }
  if (status.cancelRequested) {
    throw new Error('List sorting was cancelled.');
  }

  const raw = await withRetry(
    () =>
      generateJson<unknown>(
        settings,
        ASSIGNMENT_SYSTEM_PROMPT,
        buildAssignmentPrompt({ batch, totalBatches, taxonomy, criteria, context }),
        { maxTokens: 8192, jsonMode: true },
      ),
    { attempts: 3, baseDelayMs: 1500 },
  );
  const parsed = parseBatchAssignments(
    raw,
    taxonomy.length,
    batch.rows.length,
    taxonomy.map((group) => group.name),
  );
  return {
    index: batch.index,
    offset: batch.offset,
    rowCount: batch.rows.length,
    assignments: parsed.assignments,
    warnings: parsed.warnings,
  };
}

/**
 * Process one queued large-list sort. Completed batches are checkpointed, so a worker retry
 * resumes without spending the same AI tokens again.
 */
export async function processListSegmentation(listId: string, runId: string): Promise<void> {
  const rec = await getList(listId);
  if (!rec) {
    const status = await getListSegmentStatus(listId);
    if (status?.runId === runId) {
      await saveListSegmentStatus(listId, {
        ...status,
        status: 'failed',
        error: 'The list was deleted before sorting finished.',
        finishedAt: Date.now(),
      });
    }
    return;
  }

  const rows = listDataRows(rec.content);
  const existing = await getListSegmentStatus(listId);
  if (existing && existing.runId !== runId) return;
  const totalBatches = Math.max(1, Math.ceil(rows.length / env.LIST_SEGMENT_BATCH_SIZE));
  let status = existing?.runId === runId ? existing : initialStatus(runId, rows.length, totalBatches);

  if (status.cancelRequested || status.status === 'cancelled') {
    await cancelRun(listId, runId);
    return;
  }

  status = {
    ...status,
    status: 'running',
    totalRows: rows.length,
    totalBatches,
    startedAt: status.startedAt ?? Date.now(),
    finishedAt: undefined,
    error: undefined,
  };
  await saveListSegmentStatus(listId, status);

  let stopped = false;
  try {
    assertSegmentable(rows, rec.content.length, LIST_MAX_ROWS, LIST_MAX_CHARS);

    const settings = await getAiSettings();
    if (!settings || !settings.apiKey) {
      throw new Error('AI not configured. Set it in Settings → AI.');
    }

    const kb = await getAllKnowledge();
    const context = retrieveContext(kb, `${rec.criteria} ${rec.name}`);
    const batches = batchRows(rows, env.LIST_SEGMENT_BATCH_SIZE);

    let taxonomy = status.taxonomy;
    if (!taxonomy?.length) {
      const sample = sampleRows(rows, env.LIST_SEGMENT_TAXONOMY_SAMPLE);
      const raw = await withRetry(
        () =>
          generateJson<unknown>(
            settings,
            TAXONOMY_SYSTEM_PROMPT,
            buildTaxonomyPrompt({ sample, criteria: rec.criteria, context }),
            { maxTokens: 2048, jsonMode: true },
          ),
        { attempts: 3, baseDelayMs: 1500 },
      );
      taxonomy = parseTaxonomy(raw);
      status = (await updateListSegmentStatus(listId, {
        taxonomy,
        totalRows: rows.length,
        totalBatches,
      })) as ListSegmentationStatus;
    }

    const beforeBatches = await getListSegmentStatus(listId);
    if (!beforeBatches) return;
    if (beforeBatches.cancelRequested) {
      await cancelRun(listId, runId);
      return;
    }

    const completed = await getListSegmentBatches(listId, runId);
    const byIndex = new Map<number, BatchResult>();
    for (const batchResult of completed) {
      const expected = batches[batchResult.index];
      if (!expected) continue;
      if (batchResult.offset !== expected.offset || batchResult.rowCount !== expected.rows.length) continue;
      byIndex.set(batchResult.index, batchResult);
    }

    let processedRows = 0;
    let processedBatches = 0;
    const warnings = new Set<string>();
    for (const batchResult of byIndex.values()) {
      processedRows += batchResult.rowCount;
      processedBatches += 1;
      for (const warning of batchResult.warnings) warnings.add(warning);
    }

    await updateListSegmentStatus(listId, {
      processedRows,
      processedBatches,
      warnings: warnings.size ? Array.from(warnings) : undefined,
    });

    let progressChain = Promise.resolve();
    const recordProgress = (batchResult: BatchResult): Promise<void> => {
      processedRows += batchResult.rowCount;
      processedBatches += 1;
      for (const warning of batchResult.warnings) warnings.add(warning);
      progressChain = progressChain.then(async () => {
        if (stopped) return;
        await updateListSegmentStatus(listId, {
          processedRows,
          processedBatches,
          warnings: warnings.size ? Array.from(warnings) : undefined,
        });
      });
      return progressChain;
    };

    const pending = batches.filter((batch) => !byIndex.has(batch.index));
    await forEachLimit(pending, env.LIST_SEGMENT_AI_CONCURRENCY, async (batch) => {
      const latest = await getListSegmentStatus(listId);
      if (!latest || latest.cancelRequested) return;

      const batchResult = await callAssignment(
        settings,
        listId,
        batch,
        totalBatches,
        taxonomy,
        rec.criteria,
        context,
      );
      await saveListSegmentBatch(listId, runId, batchResult);
      byIndex.set(batch.index, batchResult);
      await recordProgress(batchResult);
    });

    const latest = await getListSegmentStatus(listId);
    if (!latest) return;
    if (latest.cancelRequested) {
      await cancelRun(listId, runId);
      return;
    }

    const stillExists = await getList(listId);
    if (!stillExists) return;

    const finalBatches: BatchResult[] = [];
    for (const batch of batches) {
      const result = byIndex.get(batch.index);
      if (!result) throw new Error(`Batch ${batch.index + 1} did not finish.`);
      finalBatches.push(result);
    }

    const result = mergeBatchResults(taxonomy, finalBatches, rows);
    await saveListResult(listId, result);
    await saveListSegmentStatus(listId, {
      ...(latest ?? status),
      status: 'done',
      totalRows: rows.length,
      processedRows: rows.length,
      totalBatches: batches.length,
      processedBatches: batches.length,
      warnings: result.warnings?.length ? result.warnings : undefined,
      error: undefined,
      finishedAt: Date.now(),
    });
    await deleteListSegmentBatches(listId, runId);
  } catch (err) {
    stopped = true;
    const latest = await getListSegmentStatus(listId);
    if (!latest) return;
    if (latest.cancelRequested || latest.status === 'cancelled') {
      await cancelRun(listId, runId);
      return;
    }
    logger.error({ err, listId, runId }, 'list segmentation job failed');
    await failRun(listId, runId, err);
    throw err;
  }
}
