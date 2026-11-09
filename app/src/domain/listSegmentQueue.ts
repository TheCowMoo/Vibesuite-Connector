import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { listSegmentQueue } from '../queue/queues';
import type { ListSegmentJobData } from '../queue/jobs/types';
import {
  deleteListSegmentation,
  getListSegmentStatus,
  getListSegmentStatuses,
  saveListSegmentStatus,
  updateListSegmentStatus,
  type ListSegmentationStatus,
} from './listSegmentStore';

export { deleteListSegmentation, getListSegmentStatus, getListSegmentStatuses };

/**
 * Queue a large-list sort. A failed run keeps its runId so the worker resumes from its
 * checkpointed batches; a completed or cancelled run starts a fresh taxonomy.
 */
export async function enqueueListSegmentation(
  listId: string,
  totalRows: number,
): Promise<ListSegmentationStatus> {
  const current = await getListSegmentStatus(listId);
  if (current && (current.status === 'queued' || current.status === 'running')) {
    return current;
  }

  const resume = current?.status === 'failed' ? current.runId : randomUUID();
  const totalBatches = Math.max(1, Math.ceil(totalRows / env.LIST_SEGMENT_BATCH_SIZE));
  const now = Date.now();
  const status: ListSegmentationStatus = {
    status: 'queued',
    runId: resume,
    totalRows,
    processedRows: current?.status === 'failed' ? current.processedRows : 0,
    totalBatches,
    processedBatches: current?.status === 'failed' ? current.processedBatches : 0,
    taxonomy: current?.status === 'failed' ? current.taxonomy : undefined,
    warnings: current?.status === 'failed' ? current.warnings : undefined,
    createdAt: current?.status === 'failed' ? current.createdAt : now,
  };
  const jobId = `list-segment-${listId}-${resume}-${now}`;
  status.jobId = jobId;
  await saveListSegmentStatus(listId, status);

  try {
    const data: ListSegmentJobData = { listId, runId: resume };
    await listSegmentQueue.add('segment-list', data, { jobId });
  } catch (err) {
    const message = (err as Error).message || 'Could not queue the list sort.';
    await updateListSegmentStatus(listId, {
      status: 'failed',
      error: message,
      finishedAt: Date.now(),
    });
    logger.error({ err, listId }, 'could not enqueue list segmentation');
    throw err;
  }

  return status;
}

export async function cancelListSegmentation(
  listId: string,
): Promise<ListSegmentationStatus | null> {
  const current = await getListSegmentStatus(listId);
  if (!current) return null;
  if (current.status !== 'queued' && current.status !== 'running') return current;

  // The worker checks this flag between batches. A queued job that has not started also
  // sees the cancelled status on its first tick.
  return updateListSegmentStatus(listId, {
    status: current.status === 'queued' ? 'cancelled' : current.status,
    cancelRequested: true,
    ...(current.status === 'queued' ? { finishedAt: Date.now() } : {}),
  });
}
